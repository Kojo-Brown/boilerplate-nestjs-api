import { JSON_SCHEMA_DRAFT, SchemaProfileError, assertInProfile } from "./json-schema";

/** A minimal document that is in the profile, to mutate one keyword at a time. */
function schema(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    $schema: JSON_SCHEMA_DRAFT,
    $id: "urn:test:thing:1",
    title: "thing v1",
    type: "object",
    additionalProperties: true,
    properties: { id: { type: "string" } },
    required: ["id"],
    ...overrides,
  };
}

describe("assertInProfile", () => {
  it("accepts a document in the profile", () => {
    expect(() => assertInProfile(schema())).not.toThrow();
  });

  it("accepts nested objects and arrays", () => {
    expect(() =>
      assertInProfile(
        schema({
          properties: {
            id: { type: "string" },
            tags: { type: "array", items: { type: "string" } },
            address: {
              type: "object",
              properties: { city: { type: "string" } },
              required: ["city"],
            },
          },
          required: ["id"],
        }),
      ),
    ).not.toThrow();
  });

  it.each([
    ["a $ref", { properties: { id: { $ref: "#/definitions/id" } } }],
    ["oneOf", { properties: { id: { oneOf: [{ type: "string" }] } } }],
    ["a pattern", { properties: { id: { type: "string", pattern: "^a" } } }],
    ["patternProperties", { patternProperties: { "^x": { type: "string" } } }],
    ["a document-level if", { if: { type: "object" } }],
  ])("rejects %s, rather than ignoring it", (_description, patch) => {
    // The whole soundness argument for `checkCompatibility` is that it has read
    // every constraint in the document. A keyword it does not understand must
    // therefore be an error and not a shrug — a schema whose real constraint
    // lives in a `oneOf` this module skipped would be declared compatible with
    // anything.
    expect(() => assertInProfile(schema(patch))).toThrow(SchemaProfileError);
  });

  it("rejects a closed content model", () => {
    // The rule the whole evolution story rests on: with `additionalProperties:
    // false`, adding any field breaks every consumer that has not redeployed.
    expect(() => assertInProfile(schema({ additionalProperties: false }))).toThrow(
      /additionalProperties/,
    );
  });

  it("rejects an object with no properties at all", () => {
    const { properties: _dropped, ...rest } = schema();
    expect(() => assertInProfile({ ...rest, required: [] })).toThrow(/must declare "properties"/);
  });

  it("rejects a required entry with no property schema", () => {
    // Reachable by deleting a property and forgetting its `required` entry. The
    // field would then be required to be present and unconstrained in type.
    expect(() => assertInProfile(schema({ required: ["id", "ghost"] }))).toThrow(
      /"ghost" is required but has no entry/,
    );
  });

  it("rejects tuple-form items", () => {
    expect(() =>
      assertInProfile(
        schema({ properties: { pair: { type: "array", items: [{ type: "string" }] } } }),
      ),
    ).toThrow(/tuple-form/);
  });

  it.each([
    ["a type that is not a JSON type", { properties: { id: { type: "date" } } }],
    ["an empty enum", { properties: { id: { type: "string", enum: [] } } }],
    ["an object in an enum", { properties: { id: { type: "string", enum: [{ a: 1 }] } } }],
  ])("rejects %s", (_description, patch) => {
    expect(() => assertInProfile(schema(patch))).toThrow(SchemaProfileError);
  });

  it.each([
    ["not an object", 42],
    ["a different draft", { ...schema(), $schema: "https://json-schema.org/draft/2020-12/schema" }],
    ["missing a title", { ...schema(), title: undefined }],
    ["not an object at the root", { ...schema(), type: "string" }],
  ])("rejects a document that is %s", (_description, document) => {
    expect(() => assertInProfile(document)).toThrow(SchemaProfileError);
  });

  it("names the path of the offending keyword", () => {
    expect(() =>
      assertInProfile(
        schema({
          properties: {
            address: { type: "object", properties: { city: { type: "string", pattern: "^L" } } },
          },
          required: [],
        }),
      ),
    ).toThrow(/#\/properties\/address\/properties\/city/);
  });
});
