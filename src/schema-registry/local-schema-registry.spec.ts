import { DOMAIN_EVENT_NAMES } from "@/events";
import { IncompatibleEvolutionError } from "./compatibility";
import { JSON_SCHEMA_DRAFT, SchemaProfileError, type EventSchema } from "./json-schema";
import { LocalSchemaRegistry } from "./local-schema-registry";
import { SubjectNotRegisteredError } from "./schema-registry.errors";

function version(n: number, properties: Record<string, unknown>, required: readonly string[]) {
  return {
    $schema: JSON_SCHEMA_DRAFT,
    $id: `urn:test:user.deleted:${n}`,
    title: `user.deleted v${n}`,
    type: "object",
    additionalProperties: true,
    properties,
    required,
  } as unknown as EventSchema;
}

/**
 * A catalogue with a chosen history for `user.deleted` and a trivial one for
 * every other subject.
 *
 * Built from `DOMAIN_EVENT_NAMES` rather than listed by hand: the registry
 * requires a history for every event, so a hand-written fixture goes stale the
 * moment an event is added and fails with a `TypeError` about `undefined`
 * rather than with anything about schemas.
 */
function catalogueWith(history: readonly EventSchema[]) {
  const base = version(1, { userId: { type: "string" } }, ["userId"]);
  const catalogue: Record<string, readonly EventSchema[]> = {};
  for (const name of DOMAIN_EVENT_NAMES) catalogue[name] = [base];
  catalogue["user.deleted"] = history;
  return catalogue;
}

describe("LocalSchemaRegistry", () => {
  const registry = new LocalSchemaRegistry();

  it("serves every event in the catalogue", () => {
    expect([...registry.subjects()].sort()).toEqual([...DOMAIN_EVENT_NAMES].sort());
  });

  it("numbers versions from 1 by position, oldest first", () => {
    const history = registry.versions("user.registered");
    expect(history.map((entry) => entry.version)).toEqual(
      history.map((_entry, index) => index + 1),
    );
    expect(history[0]!.subject).toBe("user.registered");
  });

  it("serves the newest version as the reader schema", () => {
    const history = registry.versions("user.deleted");
    expect(registry.latest("user.deleted")).toBe(history.at(-1));
  });

  it("throws for a subject it does not know, naming the ones it does", () => {
    // Not `undefined`: every event is required to have a subject, so an absent
    // one is a wiring bug that should surface at boot rather than a case each
    // caller has to remember to handle.
    expect(() => registry.latest("user.renamed" as never)).toThrow(SubjectNotRegisteredError);
    expect(() => registry.latest("user.renamed" as never)).toThrow(/user\.registered/);
  });

  describe("checks the catalogue at construction", () => {
    // The same two checks `catalogue.spec.ts` runs as a CI gate. The
    // duplication is deliberate: the gate fails a pull request, this stops a
    // process booting with a contract it cannot honour — the state a merge that
    // bypassed CI, a bad rebase, or a hand-edited deployment would leave it in.

    it("refuses a schema outside the profile", () => {
      expect(
        () =>
          new LocalSchemaRegistry(
            catalogueWith([version(1, { userId: { $ref: "#/x" } }, [])]) as never,
          ),
      ).toThrow(SchemaProfileError);
    });

    it("refuses a history that is not fully compatible", () => {
      expect(
        () =>
          new LocalSchemaRegistry(
            catalogueWith([
              version(1, { userId: { type: "string" } }, ["userId"]),
              version(2, { userId: { type: "string" }, email: { type: "string" } }, [
                "userId",
                "email",
              ]),
            ]) as never,
          ),
      ).toThrow(IncompatibleEvolutionError);
    });

    it("accepts a history that only adds optional properties", () => {
      expect(
        () =>
          new LocalSchemaRegistry(
            catalogueWith([
              version(1, { userId: { type: "string" } }, ["userId"]),
              version(2, { userId: { type: "string" }, email: { type: "string" } }, ["userId"]),
            ]) as never,
          ),
      ).not.toThrow();
    });

    it("refuses an empty history", () => {
      expect(() => new LocalSchemaRegistry(catalogueWith([]) as never)).toThrow(
        SubjectNotRegisteredError,
      );
    });
  });
});
