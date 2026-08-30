import {
  assertInProfile,
  isArrayNode,
  isObjectNode,
  typeNamesOf,
  type EventSchema,
  type JsonScalar,
  type ObjectSchemaNode,
  type PrimitiveType,
  type ScalarSchemaNode,
  type SchemaNode,
} from "./json-schema";

/**
 * Whether a schema change is safe, and in which direction.
 *
 * The two directions are not opinions, they are two different deployments:
 *
 * - **Backward** — a *new reader* can read data written against the *old*
 *   schema. This is the consumer-first rollout: deploy consumers, then
 *   producers. It is what the retained log needs too, since a consumer that
 *   starts from the beginning of a topic reads years of old writers' bytes.
 * - **Forward** — an *old reader* can read data written against the *new*
 *   schema. This is the producer-first rollout: deploy producers, then
 *   consumers.
 *
 * A rolling deploy is neither, because during it both are true at once: old and
 * new consumers read one topic that old and new producers are both writing to,
 * in an order nobody controls. Which is why this repository's gate is FULL —
 * both directions — and not one of them.
 */
export type CompatibilityDirection = "backward" | "forward";

export const BOTH_DIRECTIONS: readonly CompatibilityDirection[] = ["backward", "forward"];

/** One reason two schemas are not compatible. */
export interface Incompatibility {
  /** JSON-Pointer-ish location, e.g. `#/properties/email`. */
  readonly path: string;
  /** A stable identifier for the rule, so a test can assert on it. */
  readonly rule: string;
  /** Which directions this breaks. Never empty. */
  readonly breaks: readonly CompatibilityDirection[];
  /** What changed, in the terms an author of the change would recognise. */
  readonly detail: string;
}

/** A candidate schema cannot be registered because it breaks an existing one. */
export class IncompatibleEvolutionError extends Error {
  constructor(
    readonly subject: string,
    readonly previousVersion: number,
    readonly nextVersion: number,
    readonly findings: readonly Incompatibility[],
  ) {
    super(
      `Schema "${subject}" v${nextVersion} is not fully compatible with v${previousVersion}:\n` +
        findings
          .map((f) => `  - [${f.breaks.join("+")}] ${f.path}: ${f.detail} (${f.rule})`)
          .join("\n") +
        `\nAdd a new optional property instead of changing an existing one, or publish the ` +
        `change as a new event name.`,
    );
    this.name = "IncompatibleEvolutionError";
  }
}

/**
 * Every way `next` is not a compatible successor of `previous`.
 *
 * Both schemas are re-checked against the profile first, and that is not
 * defensive noise: this function's soundness rests entirely on the claim that it
 * has read every constraint in both documents, and the profile check is what
 * establishes it. A caller that hands over a schema with a `$ref` gets an error
 * rather than a clean bill of health for a document three quarters of which was
 * never examined.
 *
 * An empty result means fully compatible.
 */
export function checkCompatibility(previous: unknown, next: unknown): Incompatibility[] {
  assertInProfile(previous, "#(previous)");
  assertInProfile(next, "#(next)");

  const findings: Incompatibility[] = [];
  compareNodes(previous as EventSchema, next as EventSchema, "#", findings);
  return findings;
}

/** Throws {@link IncompatibleEvolutionError} unless the evolution is fully compatible. */
export function assertFullyCompatible(
  subject: string,
  previous: { readonly version: number; readonly schema: unknown },
  next: { readonly version: number; readonly schema: unknown },
): void {
  const findings = checkCompatibility(previous.schema, next.schema);
  if (findings.length > 0) {
    throw new IncompatibleEvolutionError(subject, previous.version, next.version, findings);
  }
}

/**
 * FULL **transitive** compatibility over a subject's whole history: every
 * version against every earlier version, not merely against its predecessor.
 *
 * The distinction is the one Confluent draws between `FULL` and
 * `FULL_TRANSITIVE`, and here it is load-bearing rather than a setting. A
 * consumer validates an incoming payload against the *latest* schema it knows,
 * while the writer may be several versions behind — an old replica mid-rollout,
 * or a message that has been sitting in the retained log since v1. Checking only
 * consecutive pairs permits a drift that walks: v1→v2 renames nothing, v2→v3
 * renames nothing, and v1→v3 has moved a field from required to optional to
 * gone. Every step legal, the end points incompatible, and the first symptom is
 * a replay dead-lettering the beginning of the topic.
 *
 * The cost is that the history can only ever grow in ways that suit *all* of it,
 * which is precisely the constraint that makes a retained log readable.
 */
export function assertHistoryIsFullyCompatible(
  subject: string,
  versions: readonly { readonly version: number; readonly schema: unknown }[],
): void {
  for (let older = 0; older < versions.length; older += 1) {
    for (let newer = older + 1; newer < versions.length; newer += 1) {
      // Non-null: both indices are inside the array by construction, and
      // `noUncheckedIndexedAccess` cannot see that.
      assertFullyCompatible(subject, versions[older]!, versions[newer]!);
    }
  }
}

function compareNodes(
  previous: SchemaNode,
  next: SchemaNode,
  path: string,
  findings: Incompatibility[],
): void {
  const previousKind = kindOf(previous);
  const nextKind = kindOf(next);

  if (previousKind !== nextKind) {
    findings.push({
      path,
      rule: "kind-changed",
      breaks: BOTH_DIRECTIONS,
      detail: `changed from ${previousKind} to ${nextKind}; neither reader can read the other's data`,
    });
    return;
  }

  // Exactly one of the three runs, because the kinds have just been proven
  // equal. Written as three narrowing pairs rather than a `switch` and two casts
  // so that each branch's operands are the node type it reads.
  if (isObjectNode(previous) && isObjectNode(next)) {
    compareObjects(previous, next, path, findings);
    return;
  }
  if (isArrayNode(previous) && isArrayNode(next)) {
    compareNodes(previous.items, next.items, `${path}/items`, findings);
    return;
  }
  if (isScalarNode(previous) && isScalarNode(next)) {
    compareScalars(previous, next, path, findings);
  }
}

function isScalarNode(node: SchemaNode): node is ScalarSchemaNode {
  return !isObjectNode(node) && !isArrayNode(node);
}

function compareObjects(
  previous: ObjectSchemaNode,
  next: ObjectSchemaNode,
  path: string,
  findings: Incompatibility[],
): void {
  const previousRequired = new Set(previous.required ?? []);
  const nextRequired = new Set(next.required ?? []);
  const keys = new Set([...Object.keys(previous.properties), ...Object.keys(next.properties)]);

  for (const key of keys) {
    const before = previous.properties[key];
    const after = next.properties[key];
    const childPath = `${path}/properties/${key}`;

    if (before !== undefined && after !== undefined) {
      if (!previousRequired.has(key) && nextRequired.has(key)) {
        findings.push({
          path: childPath,
          rule: "optional-became-required",
          breaks: ["backward"],
          detail:
            `"${key}" was optional and is now required; data already written may omit it, ` +
            `and a reader on the new schema rejects it`,
        });
      }
      if (previousRequired.has(key) && !nextRequired.has(key)) {
        findings.push({
          path: childPath,
          rule: "required-became-optional",
          breaks: ["forward"],
          detail:
            `"${key}" was required and is now optional; a writer on the new schema may omit ` +
            `it, and a reader still on the old one rejects that`,
        });
      }
      compareNodes(before, after, childPath, findings);
      continue;
    }

    if (before !== undefined) {
      // Removed. Harmless backward — the content model is open, so a reader on
      // the new schema simply ignores a property it no longer declares — and
      // harmless forward too *if* it was optional, since an old reader never
      // insisted on it.
      if (previousRequired.has(key)) {
        findings.push({
          path: childPath,
          rule: "required-property-removed",
          breaks: ["forward"],
          detail:
            `required "${key}" was removed; a writer on the new schema omits it, and a ` +
            `reader still on the old one requires it`,
        });
      }
      continue;
    }

    if (nextRequired.has(key)) {
      findings.push({
        path: childPath,
        rule: "required-property-added",
        breaks: ["backward"],
        detail:
          `"${key}" is new and required; nothing already written contains it, so a reader ` +
          `on the new schema rejects the whole history. Add it as optional instead`,
      });
    }
  }
}

function compareScalars(
  previous: ScalarSchemaNode,
  next: ScalarSchemaNode,
  path: string,
  findings: Incompatibility[],
): void {
  const previousTypes = primitiveTypesOf(previous, path);
  const nextTypes = primitiveTypesOf(next, path);
  const typeBreaks: CompatibilityDirection[] = [];
  // Backward asks whether the new reader accepts every type the old writer could
  // produce; forward asks the mirror. Both fail only when the sets overlap
  // without either containing the other — `string` becoming `number|boolean`.
  if (!covers(nextTypes, previousTypes)) typeBreaks.push("backward");
  if (!covers(previousTypes, nextTypes)) typeBreaks.push("forward");
  if (typeBreaks.length > 0) {
    findings.push({
      path,
      rule: "type-changed",
      breaks: typeBreaks,
      detail: `type went from ${format(previousTypes)} to ${format(nextTypes)}`,
    });
  }

  compareConstraint(
    previous.enum,
    next.enum,
    path,
    "enum",
    findings,
    (a, b) => a.every((value) => b.includes(value)) && b.every((value) => a.includes(value)),
    (values) => `[${values.map((value) => JSON.stringify(value)).join(", ")}]`,
    enumBreaks,
  );

  compareConstraint(
    previous.format,
    next.format,
    path,
    "format",
    findings,
    (a, b) => a === b,
    (value) => `"${value}"`,
    // Two different formats: nothing here can prove one accepts a superset of
    // the other's values, so both directions are reported. Conservative on
    // purpose — a checker that guesses is worse than one that says it cannot
    // tell, because the guess is what gets believed.
    () => BOTH_DIRECTIONS,
  );
}

/**
 * The shared shape of `enum` and `format`: a constraint that may be absent on
 * either side, where absent means "unconstrained".
 *
 * Dropping a constraint widens what a writer may emit — safe for a new reader
 * reading old data, unsafe for an old reader reading new data — and adding one
 * narrows it, which is the mirror. Only the both-present-and-different case
 * needs a rule of its own, which is what `whenDifferent` supplies.
 */
function compareConstraint<T>(
  previous: T | undefined,
  next: T | undefined,
  path: string,
  keyword: string,
  findings: Incompatibility[],
  equal: (a: T, b: T) => boolean,
  show: (value: T) => string,
  whenDifferent: (a: T, b: T) => readonly CompatibilityDirection[],
): void {
  if (previous === undefined && next === undefined) return;

  if (previous === undefined && next !== undefined) {
    findings.push({
      path,
      rule: `${keyword}-added`,
      breaks: ["backward"],
      detail: `"${keyword}" ${show(next)} is new; values already written are not constrained by it`,
    });
    return;
  }
  if (previous !== undefined && next === undefined) {
    findings.push({
      path,
      rule: `${keyword}-removed`,
      breaks: ["forward"],
      detail:
        `"${keyword}" ${show(previous)} was removed; a writer on the new schema may emit ` +
        `values a reader still on the old one rejects`,
    });
    return;
  }
  if (previous !== undefined && next !== undefined && !equal(previous, next)) {
    findings.push({
      path,
      rule: `${keyword}-changed`,
      breaks: whenDifferent(previous, next),
      detail: `"${keyword}" went from ${show(previous)} to ${show(next)}`,
    });
  }
}

function enumBreaks(
  previous: readonly JsonScalar[],
  next: readonly JsonScalar[],
): readonly CompatibilityDirection[] {
  const breaks: CompatibilityDirection[] = [];
  // Adding a member widens: old data still validates (backward safe) but a new
  // writer can emit a value the old reader has never heard of.
  if (!previous.every((value) => next.includes(value))) breaks.push("backward");
  if (!next.every((value) => previous.includes(value))) breaks.push("forward");
  return breaks;
}

/**
 * Whether every type in `subset` is accepted by `superset`.
 *
 * `integer` is the one containment JSON Schema defines between two type names,
 * and skipping it would report the widening `integer` → `number` as breaking
 * both directions when it only breaks forward. Nothing else nests.
 */
function covers(superset: ReadonlySet<PrimitiveType>, subset: ReadonlySet<PrimitiveType>): boolean {
  for (const type of subset) {
    if (superset.has(type)) continue;
    if (type === "integer" && superset.has("number")) continue;
    return false;
  }
  return true;
}

function primitiveTypesOf(node: ScalarSchemaNode, path: string): ReadonlySet<PrimitiveType> {
  return new Set(typeNamesOf(node.type, path) as readonly PrimitiveType[]);
}

function format(types: ReadonlySet<PrimitiveType>): string {
  return [...types].sort().join("|");
}

function kindOf(node: SchemaNode): "object" | "array" | "scalar" {
  if (node.type === "object") return "object";
  if (node.type === "array") return "array";
  return "scalar";
}
