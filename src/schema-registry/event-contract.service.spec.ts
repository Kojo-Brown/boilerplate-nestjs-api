import { EventContract } from "./event-contract.service";
import { JSON_SCHEMA_DRAFT, type EventSchema } from "./json-schema";
import { LocalSchemaRegistry } from "./local-schema-registry";
import { SchemaCompilationError, SchemaValidationError } from "./schema-registry.errors";
import type { RegisteredSchema, SchemaRegistry, SchemaRegistryName, Subject } from "./ports";

/** A registry that serves exactly what a spec hands it, profile checks and all bypassed. */
class StubRegistry implements SchemaRegistry {
  readonly name: SchemaRegistryName = "local";

  constructor(private readonly histories: ReadonlyMap<Subject, readonly EventSchema[]>) {}

  subjects(): readonly Subject[] {
    return [...this.histories.keys()];
  }

  versions(subject: Subject): readonly RegisteredSchema[] {
    return (this.histories.get(subject) ?? []).map((schema, index) => ({
      subject,
      version: index + 1,
      schema,
    }));
  }

  latest(subject: Subject): RegisteredSchema {
    const history = this.versions(subject);
    return history[history.length - 1]!;
  }
}

function schema(n: number, properties: Record<string, unknown>, required: readonly string[]) {
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

describe("EventContract", () => {
  const contract = new EventContract(new LocalSchemaRegistry());

  it("returns the version that validated the payload", () => {
    const expected = new LocalSchemaRegistry().latest("user.deleted").version;
    expect(contract.validate("user.deleted", { userId: "u1", email: "a@example.test" })).toBe(
      expected,
    );
  });

  it("validates against the newest version, not the oldest", () => {
    // The reader schema. v1 would accept a payload missing `email`; v2 must not,
    // and a contract that quietly validated against the first entry would let
    // one through.
    const registry = new StubRegistry(
      new Map([
        [
          "user.deleted" as Subject,
          [
            schema(1, { userId: { type: "string" } }, ["userId"]),
            schema(2, { userId: { type: "string" }, email: { type: "string" } }, [
              "userId",
              "email",
            ]),
          ],
        ],
      ]),
    );

    const strict = new EventContract(registry);
    expect(strict.validate("user.deleted", { userId: "u1", email: "a@example.test" })).toBe(2);
    expect(() => strict.validate("user.deleted", { userId: "u1" })).toThrow(SchemaValidationError);
  });

  it("reports the subject and the version that rejected the payload", () => {
    let thrown: SchemaValidationError | undefined;
    try {
      contract.validate("user.deleted", { userId: "u1" });
    } catch (caught: unknown) {
      thrown = caught as SchemaValidationError;
    }

    expect(thrown).toBeInstanceOf(SchemaValidationError);
    expect(thrown!.subject).toBe("user.deleted");
    expect(thrown!.version).toBe(1);
    expect(thrown!.violations.join(" ")).toMatch(/email/);
  });

  it("names the document itself when the failure is at the root", () => {
    // Ajv's `instancePath` is `""` there, which would read as a missing field
    // name in a message that is otherwise a list of them.
    let thrown: SchemaValidationError | undefined;
    try {
      contract.validate("user.deleted", "not an object");
    } catch (caught: unknown) {
      thrown = caught as SchemaValidationError;
    }
    expect(thrown!.violations[0]).toMatch(/^#/);
  });

  it("rejects a value that is undefined at runtime despite its type", () => {
    // The case the compiler cannot see and the reason `TransactionalOutbox`
    // validates before it writes a row: a nullable column read back empty, or a
    // value widened through an `unknown` on the way in.
    expect(() =>
      contract.validate("user.registered", {
        userId: "u1",
        email: "a@example.test",
        name: undefined,
        provider: null,
      }),
    ).toThrow(SchemaValidationError);
  });

  it("fails at construction on a schema Ajv cannot compile", () => {
    // A boot failure, not a runtime one: a service that started anyway would be
    // one that has quietly stopped validating.
    const broken = new StubRegistry(
      new Map([["user.deleted" as Subject, [schema(1, { userId: { type: "sting" } }, [])]]]),
    );
    expect(() => new EventContract(broken)).toThrow(SchemaCompilationError);
  });

  it("reports a subject with no compiled schema rather than crashing", () => {
    const empty = new StubRegistry(new Map());
    const contractWithout = new EventContract(empty);
    expect(() => contractWithout.validate("user.deleted", {})).toThrow(SchemaValidationError);
  });

  it("exposes the reader version without validating anything", () => {
    expect(contract.readerVersion("user.registered")).toBe(
      new LocalSchemaRegistry().latest("user.registered").version,
    );
  });
});
