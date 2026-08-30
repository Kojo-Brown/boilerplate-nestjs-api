/**
 * The subset of JSON Schema this repository's event contracts are written in.
 *
 * A compatibility checker is only as sound as its coverage: one that walks a
 * schema, understands `type` and `required`, and quietly ignores `oneOf`,
 * `$ref`, `if`/`then`, `patternProperties` and `dependentRequired` will report
 * "compatible" for an evolution that breaks every consumer, because the part it
 * did not read is the part that changed. So the profile is closed rather than
 * open: {@link assertInProfile} rejects any keyword this module cannot reason
 * about, by name and by path, and {@link checkCompatibility} refuses to run on a
 * schema that has not passed it.
 *
 * Widening the profile is a deliberate change in two places at once — a case
 * here and a rule in `compatibility.ts` — which is the coupling that keeps the
 * gate honest. That is worth more than accepting arbitrary JSON Schema and
 * hoping the interesting keywords never appear.
 *
 * Draft-07 rather than 2020-12, because Confluent Schema Registry's JSON Schema
 * support is draft-07 and these documents are meant to be publishable to one
 * verbatim.
 */

/** The JSON Schema draft every document in the catalogue declares. */
export const JSON_SCHEMA_DRAFT = "http://json-schema.org/draft-07/schema#" as const;

/** The scalar `type` values the profile allows. */
export const PRIMITIVE_TYPES = ["string", "number", "integer", "boolean", "null"] as const;

export type PrimitiveType = (typeof PRIMITIVE_TYPES)[number];

/** What an `enum` entry may be. Objects and arrays in an `enum` are outside the profile. */
export type JsonScalar = string | number | boolean | null;

/**
 * An object node.
 *
 * `additionalProperties` is `true` or absent — never `false` — and that is the
 * single most consequential rule in the profile. A closed content model makes a
 * JSON Schema almost unevolvable: adding a field breaks every reader that has
 * not been redeployed, because their schema forbids the field they do not know.
 * An open content model is what lets a producer add an optional field and roll
 * out ahead of its consumers, which is the ordinary way a system changes.
 *
 * The cost is that a typo in a field name is not a validation error — it is an
 * unknown property, silently accepted, and a required field reported missing
 * only if it was required. That is the trade every schema registry makes for
 * the same reason.
 */
export interface ObjectSchemaNode {
  readonly type: "object";
  readonly description?: string;
  readonly properties: Readonly<Record<string, SchemaNode>>;
  readonly required?: readonly string[];
  readonly additionalProperties?: true;
}

/** An array node. Tuple form (`items` as an array) is outside the profile. */
export interface ArraySchemaNode {
  readonly type: "array";
  readonly description?: string;
  readonly items: SchemaNode;
}

/** A scalar node, optionally constrained by `enum` or `format`. */
export interface ScalarSchemaNode {
  readonly type: PrimitiveType | readonly PrimitiveType[];
  readonly description?: string;
  /**
   * Enforced by `ajv-formats`, so a `format` in a document is a real constraint
   * rather than the annotation plain Ajv would silently ignore.
   *
   * Nothing in the shipped catalogue uses one, deliberately: a wire contract
   * asserts *structure*, and re-asserting business validation at the wire is how
   * you dead-letter data your own API already accepted — Ajv's `email` regex and
   * `class-validator`'s `IsEmail` do not agree, and the disagreement would only
   * ever be discovered by a consumer rejecting a real user's address.
   */
  readonly format?: string;
  readonly enum?: readonly JsonScalar[];
}

export type SchemaNode = ObjectSchemaNode | ArraySchemaNode | ScalarSchemaNode;

/**
 * A whole event contract: an object node with the document-level keywords.
 *
 * `$id` is the identity a registry stores it under and the string an error
 * message quotes, so it carries the subject and the version rather than being a
 * bare file name.
 */
export interface EventSchema extends ObjectSchemaNode {
  readonly $schema: typeof JSON_SCHEMA_DRAFT;
  readonly $id: string;
  readonly title: string;
}

/** A schema that uses something the profile does not cover. */
export class SchemaProfileError extends Error {
  constructor(
    readonly path: string,
    reason: string,
  ) {
    super(
      `Schema is outside the supported profile at ${path}: ${reason}. ` +
        `See src/schema-registry/json-schema.ts — the compatibility checker refuses ` +
        `keywords it cannot reason about rather than passing them silently.`,
    );
    this.name = "SchemaProfileError";
  }
}

const DOCUMENT_KEYWORDS = ["$schema", "$id", "title"] as const;
const OBJECT_KEYWORDS = ["type", "description", "properties", "required", "additionalProperties"];
const ARRAY_KEYWORDS = ["type", "description", "items"];
const SCALAR_KEYWORDS = ["type", "description", "format", "enum"];

/**
 * Narrows an untrusted document to {@link EventSchema}, or explains why it is
 * not one.
 *
 * The runtime check exists even though the catalogue is written in TypeScript
 * and already satisfies the type: a schema fetched from a remote registry, or
 * read from a file, arrives as `unknown`, and the gate that asserts the
 * catalogue is in profile has to be an assertion rather than a restatement of
 * what the compiler already proved.
 */
export function assertInProfile(document: unknown, path = "#"): asserts document is EventSchema {
  const root = asRecord(document, path);

  for (const keyword of DOCUMENT_KEYWORDS) {
    if (typeof root[keyword] !== "string") {
      throw new SchemaProfileError(path, `"${keyword}" must be a string`);
    }
  }
  if (root["$schema"] !== JSON_SCHEMA_DRAFT) {
    throw new SchemaProfileError(path, `"$schema" must be "${JSON_SCHEMA_DRAFT}"`);
  }
  if (root["type"] !== "object") {
    throw new SchemaProfileError(path, `the document root must be an object schema`);
  }

  assertNodeInProfile(root, path, DOCUMENT_KEYWORDS);
}

function assertNodeInProfile(
  node: Readonly<Record<string, unknown>>,
  path: string,
  extraKeywords: readonly string[] = [],
): void {
  const type = node["type"];

  if (type === "object") {
    assertKeywords(node, path, [...OBJECT_KEYWORDS, ...extraKeywords]);
    const properties = node["properties"];
    if (properties === undefined) {
      // Absent `properties` on an open object constrains nothing at all, which
      // is a schema that accepts every JSON object and would report every
      // evolution compatible. Almost certainly a mistake; loud rather than
      // permissive.
      throw new SchemaProfileError(path, `an object schema must declare "properties"`);
    }
    const propertyMap = asRecord(properties, `${path}/properties`);
    for (const [key, child] of Object.entries(propertyMap)) {
      const childPath = `${path}/properties/${key}`;
      assertNodeInProfile(asRecord(child, childPath), childPath);
    }

    const required = node["required"];
    if (required !== undefined) {
      if (!Array.isArray(required) || required.some((entry) => typeof entry !== "string")) {
        throw new SchemaProfileError(path, `"required" must be an array of strings`);
      }
      for (const key of required as readonly string[]) {
        if (!(key in propertyMap)) {
          // A required property with no schema is required to be *present* and
          // unconstrained in type — reachable by deleting a property and
          // forgetting its `required` entry, and invisible in review.
          throw new SchemaProfileError(
            path,
            `"${key}" is required but has no entry in "properties"`,
          );
        }
      }
    }

    const additional = node["additionalProperties"];
    if (additional !== undefined && additional !== true) {
      throw new SchemaProfileError(
        path,
        `"additionalProperties" must be true or absent. A closed content model cannot be ` +
          `evolved: adding a field breaks every consumer that has not been redeployed, ` +
          `because their schema forbids the field they have not heard of`,
      );
    }
    return;
  }

  if (type === "array") {
    assertKeywords(node, path, [...ARRAY_KEYWORDS, ...extraKeywords]);
    const items = node["items"];
    if (items === undefined) {
      throw new SchemaProfileError(path, `an array schema must declare "items"`);
    }
    if (Array.isArray(items)) {
      throw new SchemaProfileError(
        path,
        `tuple-form "items" is outside the profile; positional element types have their own ` +
          `compatibility rules and none are implemented`,
      );
    }
    assertNodeInProfile(asRecord(items, `${path}/items`), `${path}/items`);
    return;
  }

  assertKeywords(node, path, [...SCALAR_KEYWORDS, ...extraKeywords]);
  for (const name of typeNamesOf(type, path)) {
    if (!(PRIMITIVE_TYPES as readonly string[]).includes(name)) {
      throw new SchemaProfileError(path, `"${name}" is not a supported type`);
    }
  }

  const format = node["format"];
  if (format !== undefined && typeof format !== "string") {
    throw new SchemaProfileError(path, `"format" must be a string`);
  }

  const values = node["enum"];
  if (values !== undefined) {
    if (!Array.isArray(values) || values.length === 0) {
      throw new SchemaProfileError(path, `"enum" must be a non-empty array`);
    }
    for (const value of values) {
      if (value !== null && !["string", "number", "boolean"].includes(typeof value)) {
        throw new SchemaProfileError(
          path,
          `"enum" entries must be scalars; objects and arrays are outside the profile`,
        );
      }
    }
  }
}

/** The `type` keyword as a list, whichever of its two forms was written. */
export function typeNamesOf(type: unknown, path: string): readonly string[] {
  if (typeof type === "string") return [type];
  if (Array.isArray(type) && type.length > 0 && type.every((n) => typeof n === "string")) {
    return type as readonly string[];
  }
  throw new SchemaProfileError(path, `"type" must be a type name or a non-empty array of them`);
}

function assertKeywords(
  node: Readonly<Record<string, unknown>>,
  path: string,
  allowed: readonly string[],
): void {
  for (const keyword of Object.keys(node)) {
    if (!allowed.includes(keyword)) {
      throw new SchemaProfileError(
        path,
        `"${keyword}" is not in the profile (allowed here: ${allowed.join(", ")})`,
      );
    }
  }
}

function asRecord(value: unknown, path: string): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new SchemaProfileError(path, `expected a JSON object, got ${describe(value)}`);
  }
  return value as Readonly<Record<string, unknown>>;
}

function describe(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  return typeof value;
}

/** Whether a node is an object node, for callers walking a validated schema. */
export function isObjectNode(node: SchemaNode): node is ObjectSchemaNode {
  return node.type === "object";
}

/** Whether a node is an array node, for callers walking a validated schema. */
export function isArrayNode(node: SchemaNode): node is ArraySchemaNode {
  return node.type === "array";
}
