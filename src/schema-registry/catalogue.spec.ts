import { DOMAIN_EVENT_NAMES, type DomainEventName } from "@/events";
import { REFERENCE_PAYLOADS, SCHEMA_CATALOGUE } from "./catalogue";
import { assertHistoryIsFullyCompatible } from "./compatibility";
import { assertInProfile } from "./json-schema";
import { LocalSchemaRegistry } from "./local-schema-registry";
import { EventContract } from "./event-contract.service";
import { SchemaValidationError } from "./schema-registry.errors";

/**
 * The gate. Everything here is about the catalogue that ships, not about the
 * machinery — `compatibility.spec.ts` proves the rules, this proves they hold
 * for the schemas in this repository, and it is what fails a pull request that
 * evolves one of them badly.
 */
describe("the shipped schema catalogue", () => {
  const subjects = Object.keys(SCHEMA_CATALOGUE) as DomainEventName[];

  it("covers every event in the catalogue and nothing else", () => {
    // The mapped type already makes a missing subject a compile error. This is
    // the same claim as an assertion, so that a future catalogue built at
    // runtime — from files, or from a remote registry — is held to it too.
    expect([...subjects].sort()).toEqual([...DOMAIN_EVENT_NAMES].sort());
  });

  it.each(DOMAIN_EVENT_NAMES)("has at least one version of %s", (subject) => {
    expect(SCHEMA_CATALOGUE[subject].length).toBeGreaterThan(0);
  });

  describe.each(DOMAIN_EVENT_NAMES)("%s", (subject) => {
    const history = SCHEMA_CATALOGUE[subject];

    it("is written entirely within the supported profile", () => {
      history.forEach((schema, index) => {
        expect(() => assertInProfile(schema, `#(${subject} v${index + 1})`)).not.toThrow();
      });
    });

    it("evolves compatibly across its whole history, not just consecutive versions", () => {
      // FULL_TRANSITIVE. A consumer validates against the newest schema it
      // knows while the writer may be several versions back — an old replica
      // mid-rollout, or a message sitting in the retained log since v1.
      expect(() =>
        assertHistoryIsFullyCompatible(
          subject,
          history.map((schema, index) => ({ version: index + 1, schema })),
        ),
      ).not.toThrow();
    });

    it("numbers its $id and title by position", () => {
      // Version is a position in the array, so a document that names a
      // different one would be a registry disagreeing with itself.
      history.forEach((schema, index) => {
        expect(schema.$id).toMatch(new RegExp(`:${subject}:${index + 1}$`));
        expect(schema.title).toBe(`${subject} v${index + 1}`);
      });
    });

    it("is a JSON document, not merely a TypeScript object", () => {
      // These are meant to be publishable to a remote registry verbatim. A
      // `undefined`, a `Date` or a function anywhere in one would survive the
      // type check and be silently dropped or mangled by `JSON.stringify`.
      history.forEach((schema) => {
        expect(JSON.parse(JSON.stringify(schema))).toEqual(schema);
      });
    });
  });

  describe("agreement with the TypeScript payload types", () => {
    const contract = new EventContract(new LocalSchemaRegistry());

    it.each(DOMAIN_EVENT_NAMES)("accepts the reference payload for %s", (subject) => {
      expect(() => contract.validate(subject, REFERENCE_PAYLOADS[subject])).not.toThrow();
    });

    it.each(DOMAIN_EVENT_NAMES)("declares exactly the fields %s carries", (subject) => {
      // The link the compiler cannot make. `REFERENCE_PAYLOADS` is typed as the
      // payload interface, so a new field there fails to compile until it is
      // supplied; this then fails until the schema declares it. Without this the
      // two catalogues drift, and the first symptom is a consumer rejecting a
      // payload the producer's types said was fine.
      const latest = SCHEMA_CATALOGUE[subject].at(-1)!;
      expect(Object.keys(latest.properties).sort()).toEqual(
        Object.keys(REFERENCE_PAYLOADS[subject]).sort(),
      );
    });
  });

  describe("what the shipped contracts reject", () => {
    const contract = new EventContract(new LocalSchemaRegistry());

    it("rejects a missing required field", () => {
      const { email: _dropped, ...rest } = REFERENCE_PAYLOADS["user.deleted"];
      expect(() => contract.validate("user.deleted", rest)).toThrow(SchemaValidationError);
    });

    it("rejects a field of the wrong type", () => {
      expect(() =>
        contract.validate("user.registered", {
          ...REFERENCE_PAYLOADS["user.registered"],
          userId: 42,
        }),
      ).toThrow(/userId/);
    });

    it("rejects an explicitly-null value where null is not allowed", () => {
      // `email` is `string`, not `string | null`. On the wire those are
      // different bytes and a consumer written against one breaks on the other.
      expect(() =>
        contract.validate("user.registered", {
          ...REFERENCE_PAYLOADS["user.registered"],
          email: null,
        }),
      ).toThrow(SchemaValidationError);
    });

    it("accepts an explicit null where the type allows it", () => {
      expect(() =>
        contract.validate("user.registered", {
          ...REFERENCE_PAYLOADS["user.registered"],
          name: null,
        }),
      ).not.toThrow();
    });

    it("accepts a field it has never heard of", () => {
      // The open content model, exercised on the real schemas: this is what
      // lets a producer add an optional field and roll out ahead of its
      // consumers. A test that expected a rejection here would be asserting
      // that this system cannot be changed.
      expect(() =>
        contract.validate("user.registered", {
          ...REFERENCE_PAYLOADS["user.registered"],
          locale: "en-GB",
        }),
      ).not.toThrow();
    });

    it("reports every offending field at once", () => {
      // A rejected payload is a diagnosis. Reporting only the first bad field
      // turns one fix into three round trips.
      let thrown: SchemaValidationError | undefined;
      try {
        contract.validate("user.registered", { userId: 1, email: 2 });
      } catch (caught: unknown) {
        thrown = caught as SchemaValidationError;
      }
      expect(thrown!.violations.length).toBeGreaterThanOrEqual(3);
      expect(thrown!.message).toContain("user.registered");
    });
  });
});
