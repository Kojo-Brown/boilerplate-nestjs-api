import {
  IncompatibleEvolutionError,
  assertFullyCompatible,
  assertHistoryIsFullyCompatible,
  checkCompatibility,
  type CompatibilityDirection,
} from "./compatibility";
import { JSON_SCHEMA_DRAFT } from "./json-schema";

function schema(
  properties: Record<string, unknown>,
  required: readonly string[],
  version = 1,
): Record<string, unknown> {
  return {
    $schema: JSON_SCHEMA_DRAFT,
    $id: `urn:test:thing:${version}`,
    title: `thing v${version}`,
    type: "object",
    additionalProperties: true,
    properties,
    required,
  };
}

/** The rules that fired, as `rule:direction+direction`, for compact assertions. */
function rules(previous: unknown, next: unknown): string[] {
  return checkCompatibility(previous, next).map((f) => `${f.rule}:${f.breaks.join("+")}`);
}

const STRING = { type: "string" };

describe("checkCompatibility", () => {
  it("reports nothing for an unchanged schema", () => {
    expect(rules(schema({ a: STRING }, ["a"]), schema({ a: STRING }, ["a"], 2))).toEqual([]);
  });

  describe("properties", () => {
    it("allows a new optional property in both directions", () => {
      // The one evolution an open content model is designed to permit, and the
      // reason `additionalProperties` is never false: a new reader does not
      // require it, and an old reader ignores what it does not declare.
      expect(
        rules(schema({ a: STRING }, ["a"]), schema({ a: STRING, b: STRING }, ["a"], 2)),
      ).toEqual([]);
    });

    it("refuses a new required property, backward", () => {
      expect(
        rules(schema({ a: STRING }, ["a"]), schema({ a: STRING, b: STRING }, ["a", "b"], 2)),
      ).toEqual(["required-property-added:backward"]);
    });

    it("refuses promoting an optional property to required, backward", () => {
      expect(
        rules(
          schema({ a: STRING, b: STRING }, ["a"]),
          schema({ a: STRING, b: STRING }, ["a", "b"], 2),
        ),
      ).toEqual(["optional-became-required:backward"]);
    });

    it("refuses demoting a required property to optional, forward", () => {
      expect(
        rules(
          schema({ a: STRING, b: STRING }, ["a", "b"]),
          schema({ a: STRING, b: STRING }, ["a"], 2),
        ),
      ).toEqual(["required-became-optional:forward"]);
    });

    it("refuses removing a required property, forward", () => {
      expect(
        rules(schema({ a: STRING, b: STRING }, ["a", "b"]), schema({ a: STRING }, ["a"], 2)),
      ).toEqual(["required-property-removed:forward"]);
    });

    it("allows removing an optional property", () => {
      // Safe under an open content model: a new reader ignores the field if a
      // straggling writer still sends it, and an old reader never required it.
      expect(
        rules(schema({ a: STRING, b: STRING }, ["a"]), schema({ a: STRING }, ["a"], 2)),
      ).toEqual([]);
    });

    it("recurses into nested objects", () => {
      const before = schema(
        { at: { type: "object", properties: { city: STRING }, required: [] } },
        [],
      );
      const after = schema(
        { at: { type: "object", properties: { city: STRING }, required: ["city"] } },
        [],
        2,
      );
      const findings = checkCompatibility(before, after);
      expect(findings).toHaveLength(1);
      expect(findings[0]!.path).toBe("#/properties/at/properties/city");
      expect(findings[0]!.breaks).toEqual(["backward"]);
    });

    it("recurses into array items", () => {
      const before = schema({ tags: { type: "array", items: STRING } }, []);
      const after = schema({ tags: { type: "array", items: { type: "number" } } }, [], 2);
      const findings = checkCompatibility(before, after);
      expect(findings[0]!.path).toBe("#/properties/tags/items");
      expect(findings[0]!.rule).toBe("type-changed");
    });
  });

  describe("types", () => {
    const cases: [string, unknown, unknown, CompatibilityDirection[]][] = [
      ["widening string to string|null", STRING, { type: ["string", "null"] }, ["forward"]],
      ["narrowing string|null to string", { type: ["string", "null"] }, STRING, ["backward"]],
      ["integer to number", { type: "integer" }, { type: "number" }, ["forward"]],
      ["number to integer", { type: "number" }, { type: "integer" }, ["backward"]],
      ["string to number", STRING, { type: "number" }, ["backward", "forward"]],
      [
        "string to number|boolean",
        STRING,
        { type: ["number", "boolean"] },
        ["backward", "forward"],
      ],
    ];

    it.each(cases)("reports %s", (_description, before, after, breaks) => {
      const findings = checkCompatibility(schema({ a: before }, []), schema({ a: after }, [], 2));
      expect(findings).toHaveLength(1);
      expect(findings[0]!.rule).toBe("type-changed");
      expect(findings[0]!.breaks).toEqual(breaks);
    });

    it("treats a reordered type union as unchanged", () => {
      expect(
        rules(
          schema({ a: { type: ["string", "null"] } }, []),
          schema({ a: { type: ["null", "string"] } }, [], 2),
        ),
      ).toEqual([]);
    });

    it("reports a change of kind in both directions", () => {
      expect(
        rules(schema({ a: STRING }, []), schema({ a: { type: "array", items: STRING } }, [], 2)),
      ).toEqual(["kind-changed:backward+forward"]);
    });
  });

  describe("enum and format", () => {
    it("refuses adding a constraint, backward", () => {
      expect(
        rules(schema({ a: STRING }, []), schema({ a: { type: "string", enum: ["x"] } }, [], 2)),
      ).toEqual(["enum-added:backward"]);
    });

    it("refuses removing a constraint, forward", () => {
      expect(
        rules(schema({ a: { type: "string", format: "uuid" } }, []), schema({ a: STRING }, [], 2)),
      ).toEqual(["format-removed:forward"]);
    });

    it("treats a widened enum as forward-breaking only", () => {
      // A new writer can emit "y", which the old reader has never heard of;
      // everything already written is still in the new set.
      expect(
        rules(
          schema({ a: { type: "string", enum: ["x"] } }, []),
          schema({ a: { type: "string", enum: ["x", "y"] } }, [], 2),
        ),
      ).toEqual(["enum-changed:forward"]);
    });

    it("treats a narrowed enum as backward-breaking only", () => {
      expect(
        rules(
          schema({ a: { type: "string", enum: ["x", "y"] } }, []),
          schema({ a: { type: "string", enum: ["x"] } }, [], 2),
        ),
      ).toEqual(["enum-changed:backward"]);
    });

    it("ignores enum order", () => {
      expect(
        rules(
          schema({ a: { type: "string", enum: ["x", "y"] } }, []),
          schema({ a: { type: "string", enum: ["y", "x"] } }, [], 2),
        ),
      ).toEqual([]);
    });

    it("refuses two different formats in both directions", () => {
      // Nothing here can prove that one format's values are a superset of the
      // other's, and a checker that guesses is worse than one that says so.
      expect(
        rules(
          schema({ a: { type: "string", format: "uuid" } }, []),
          schema({ a: { type: "string", format: "email" } }, [], 2),
        ),
      ).toEqual(["format-changed:backward+forward"]);
    });
  });

  it("refuses to judge a schema outside the profile", () => {
    // Otherwise the empty result would read as "compatible" for a document
    // three quarters of which was never examined.
    expect(() =>
      checkCompatibility(schema({ a: STRING }, []), schema({ a: { $ref: "#/x" } }, [], 2)),
    ).toThrow(/outside the supported profile/);
  });
});

describe("assertFullyCompatible", () => {
  it("passes a compatible evolution", () => {
    expect(() =>
      assertFullyCompatible(
        "thing",
        { version: 1, schema: schema({ a: STRING }, ["a"]) },
        { version: 2, schema: schema({ a: STRING, b: STRING }, ["a"], 2) },
      ),
    ).not.toThrow();
  });

  it("names the subject, both versions, and every finding", () => {
    let thrown: IncompatibleEvolutionError | undefined;
    try {
      assertFullyCompatible(
        "thing",
        { version: 1, schema: schema({ a: STRING, b: STRING }, ["a", "b"]) },
        { version: 2, schema: schema({ a: { type: "number" } }, ["a"], 2) },
      );
    } catch (caught: unknown) {
      thrown = caught as IncompatibleEvolutionError;
    }

    expect(thrown).toBeInstanceOf(IncompatibleEvolutionError);
    expect(thrown!.subject).toBe("thing");
    expect(thrown!.previousVersion).toBe(1);
    expect(thrown!.nextVersion).toBe(2);
    expect(thrown!.findings.map((f) => f.rule).sort()).toEqual([
      "required-property-removed",
      "type-changed",
    ]);
    // The message has to carry the fix, because the person reading it is
    // mid-change and the answer ("add an optional property instead") is not
    // obvious from a list of violated rules.
    expect(thrown!.message).toMatch(/optional property/);
  });
});

describe("assertHistoryIsFullyCompatible", () => {
  it("passes a history where every pair is compatible", () => {
    expect(() =>
      assertHistoryIsFullyCompatible("thing", [
        { version: 1, schema: schema({ a: STRING }, ["a"]) },
        { version: 2, schema: schema({ a: STRING, b: STRING }, ["a"], 2) },
        { version: 3, schema: schema({ a: STRING, b: STRING, c: STRING }, ["a"], 3) },
      ]),
    ).not.toThrow();
  });

  it("catches the drift that walks: every step legal, the end points not", () => {
    // v1→v2 demotes `b` to optional, v2→v3 removes it. Each step alone breaks
    // one direction... so this history is caught by consecutive checking too.
    // The interesting case is below.
    expect(() =>
      assertHistoryIsFullyCompatible("thing", [
        { version: 1, schema: schema({ a: STRING, b: STRING }, ["a", "b"]) },
        { version: 2, schema: schema({ a: STRING, b: STRING }, ["a"], 2) },
        { version: 3, schema: schema({ a: STRING }, ["a"], 3) },
      ]),
    ).toThrow(IncompatibleEvolutionError);
  });

  it("catches an incompatibility only visible across non-adjacent versions", () => {
    // `a` goes integer → number → integer. Each consecutive step breaks one
    // direction, and v1 against v3 is identical — so a *consecutive-only* check
    // on this history would report two failures where the transitive one
    // reports the same two and no more. The case that separates them is `b`:
    // added as optional in v2 and required in v3. v2→v3 is the only pair that
    // shows it as `optional-became-required`; v1→v3 shows it as
    // `required-property-added`, which is the finding a consumer replaying from
    // v1 actually experiences.
    let thrown: IncompatibleEvolutionError | undefined;
    try {
      assertHistoryIsFullyCompatible("thing", [
        { version: 1, schema: schema({ a: STRING }, ["a"]) },
        { version: 2, schema: schema({ a: STRING, b: STRING }, ["a"], 2) },
        { version: 3, schema: schema({ a: STRING, b: STRING }, ["a", "b"], 3) },
      ]);
    } catch (caught: unknown) {
      thrown = caught as IncompatibleEvolutionError;
    }

    // v1 vs v2 is clean, so the first failure the transitive walk reaches is
    // v1 vs v3 — before v2 vs v3, which a consecutive-only check would find.
    expect(thrown).toBeInstanceOf(IncompatibleEvolutionError);
    expect(thrown!.previousVersion).toBe(1);
    expect(thrown!.nextVersion).toBe(3);
    expect(thrown!.findings.map((f) => f.rule)).toEqual(["required-property-added"]);
  });

  it("passes a single-version history", () => {
    expect(() =>
      assertHistoryIsFullyCompatible("thing", [
        { version: 1, schema: schema({ a: STRING }, ["a"]) },
      ]),
    ).not.toThrow();
  });
});
