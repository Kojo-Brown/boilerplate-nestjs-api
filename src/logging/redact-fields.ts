import { childPath, elementPath } from "./field-path";
import { REDACTED, TRUNCATED } from "./log-event";
import type { RedactionAllowlist } from "./redaction-allowlist";
import { scrubSecrets } from "./scrub-secrets";
import type { LogProcessor } from "./log-processor";

/**
 * How deep the walk goes before it stops describing and starts refusing.
 *
 * A cap rather than a trusted recursion, because the object being walked is
 * frequently shaped by a request: a deeply nested JSON body reaches a log line
 * through an error message, and a walk with no floor is a stack overflow
 * somebody else can schedule. Eight is past anything this codebase logs
 * deliberately and well short of a default stack.
 */
export const MAX_DEPTH = 8;

/**
 * How many values one record may contain.
 *
 * The second half of the same argument: depth is bounded above but breadth is
 * not, and a 10,000-key object costs 10,000 allowlist lookups and a log line no
 * backend will accept. Counting nodes rather than bytes because the cost being
 * bounded is the walk, not the output.
 */
export const MAX_NODES = 512;

/**
 * Applies an allowlist to a log event's fields.
 *
 * Structure is preserved and only leaf values are replaced — objects stay
 * objects, arrays keep their length — because the shape of a record is itself
 * diagnostic and carries nothing on its own. `{"items":[{"sku":"[redacted]"},
 * {"sku":"[redacted]"}]}` says an order had two lines, which is most of what an
 * operator wanted and none of what they may not have.
 */
export function redactFields(allowlist: RedactionAllowlist): LogProcessor {
  return (event) => ({ ...event, fields: redactRecord(event.fields, allowlist) });
}

function redactRecord(
  fields: Readonly<Record<string, unknown>>,
  allowlist: RedactionAllowlist,
): Record<string, unknown> {
  const budget = { nodes: MAX_NODES };
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    out[key] = redactValue(value, [key], allowlist, budget, new Set());
  }
  return out;
}

interface Budget {
  nodes: number;
}

function redactValue(
  value: unknown,
  path: readonly string[],
  allowlist: RedactionAllowlist,
  budget: Budget,
  seen: Set<object>,
): unknown {
  if (budget.nodes <= 0) return TRUNCATED;
  budget.nodes -= 1;

  // `null` and `undefined` pass through, and are the only values that do
  // without being admitted. They are the absence of data, so there is nothing
  // to disclose — and the distinction between "the field was not set" and "the
  // field was set and you may not see it" is one an operator needs on every
  // line. Collapsing both into `[redacted]` would destroy it.
  if (value === null || value === undefined) return value;

  if (path.length > MAX_DEPTH) return TRUNCATED;

  if (Array.isArray(value)) {
    if (seen.has(value)) return TRUNCATED;
    // Removed on the way back out, not left in the set: two sibling fields may
    // legitimately hold the same object, and a set that only ever grows would
    // report the second one as a cycle. Only an ancestor is a cycle.
    seen.add(value);
    const elements = value.map((element) =>
      redactValue(element, elementPath(path), allowlist, budget, seen),
    );
    seen.delete(value);
    return elements;
  }

  if (isPlainRecord(value)) {
    if (seen.has(value)) return TRUNCATED;
    seen.add(value);
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      out[key] = redactValue(child, childPath(path, key), allowlist, budget, seen);
    }
    seen.delete(value);
    return out;
  }

  // A leaf. Everything that is not `null` needs admitting, whatever its type:
  // a number is a salary or a date of birth, and a boolean is one bit that can
  // still be a diagnosis. Typing the decision instead of the path is how a
  // redactor ends up admitting `{ hasPriorConviction: true }`.
  if (!allowlist.admits(path)) return REDACTED;

  if (typeof value === "string") return scrubSecrets(value);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString();

  // A Date, an Error, a class instance, a function, a symbol. Admitted by path
  // but not by shape: `String(value)` on an arbitrary object runs a `toString`
  // this module does not own, on an object that may be holding the very data
  // being redacted — `[object Object]` at best and the whole entity at worst.
  // A Date is the one case worth spelling out, since it is a value type and its
  // ISO form is what a log line wants.
  if (value instanceof Date) return value.toISOString();
  return REDACTED;
}

/**
 * Whether a value is a record whose own keys are worth walking.
 *
 * `Object.create(null)` counts, and a class instance does not. The distinction
 * is not pedantry: walking an instance means reading its private fields and its
 * getters, and a getter is somebody else's code running inside the logging path
 * — where it may throw, may be expensive, and may lazily fetch the thing being
 * redacted. An instance is admitted or redacted whole, never opened up.
 */
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}
