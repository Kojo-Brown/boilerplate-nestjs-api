/**
 * The address of one value inside a log event's fields.
 *
 * ### Why a path and not a key name
 *
 * An allowlist of bare key names answers "is a field called `name` safe?",
 * which is not a question that has an answer. `{ order: { name } }` is a
 * product; `{ customer: { name } }` is a person. A key-name allowlist admits
 * both the moment it admits either, and the field that gets leaked is the one
 * nobody was picturing when they added the name.
 *
 * A path — `order.name` — says *where* a field is safe, so admitting one says
 * nothing about the other. It also makes the allowlist readable as a list of
 * decisions rather than a list of words.
 *
 * ### Why array indices collapse
 *
 * `items.0.sku` and `items.1.sku` are the same decision, and an allowlist
 * written against indices would admit the first element of a list and redact
 * the rest — a bug that looks like data corruption and would be debugged as
 * one. Every element of an array therefore shares one path, spelled
 * `items[].sku`.
 *
 * A consequence worth stating: the *position* of a value is not part of its
 * address, so an allowlist cannot admit the first element alone. Nothing here
 * has wanted to.
 */
export type FieldPath = string;

/** The segment every array element contributes, in place of its index. */
export const ARRAY_SEGMENT = "[]";

/** Matches any single segment in an allowlist pattern. */
export const WILDCARD_SEGMENT = "*";

const SEGMENT_SEPARATOR = ".";

/**
 * Extends a path with one object key.
 *
 * The key is used verbatim, including a key that contains a `.` — which is why
 * matching is done on the segment array rather than by splitting the rendered
 * path back apart. A key of `"a.b"` and a nested `{a:{b:…}}` render identically
 * and are not the same address, and a matcher that split on `.` would treat an
 * attacker-chosen key as a path into somebody else's allowlisted subtree.
 */
export function childPath(parent: readonly string[], key: string): readonly string[] {
  return [...parent, key];
}

/** Extends a path with an array element, which contributes {@link ARRAY_SEGMENT}. */
export function elementPath(parent: readonly string[]): readonly string[] {
  return [...parent, ARRAY_SEGMENT];
}

/** Renders a path for a human: `items[].sku`, `query.page`. */
export function formatPath(path: readonly string[]): FieldPath {
  return path.reduce<string>((rendered, segment) => {
    if (segment === ARRAY_SEGMENT) return `${rendered}${ARRAY_SEGMENT}`;
    return rendered === "" ? segment : `${rendered}${SEGMENT_SEPARATOR}${segment}`;
  }, "");
}

/**
 * Parses an allowlist pattern into segments.
 *
 * Returns `undefined` for anything that is not a pattern, rather than throwing
 * or quietly normalising: every caller is validating operator input
 * (`LOG_REDACTION_EXTRA_ALLOWLIST`) or a constant in this repository, and both
 * want to be told. A pattern that was silently dropped is an allowlist entry an
 * operator believes is in force.
 */
export function parsePattern(pattern: string): readonly string[] | undefined {
  if (pattern.length === 0 || pattern.trim() !== pattern) return undefined;

  const segments: string[] = [];
  for (const part of pattern.split(SEGMENT_SEPARATOR)) {
    // `items[]` is one dotted part carrying two segments, and `items[][]` is a
    // list of lists. Anything else around the brackets — `it[]ems`, `items[]x`
    // — is a typo, and the loop below refuses it by construction.
    let name = part;
    let depth = 0;
    while (name.endsWith(ARRAY_SEGMENT)) {
      name = name.slice(0, -ARRAY_SEGMENT.length);
      depth += 1;
    }
    // An empty name is `..`, a leading `.`, a trailing `.`, or a bare `[]` with
    // no field in front of it. None of those addresses anything.
    if (name.length === 0) return undefined;
    if (name.includes("[") || name.includes("]")) return undefined;
    segments.push(name, ...Array.from({ length: depth }, () => ARRAY_SEGMENT));
  }
  return segments;
}

/**
 * Whether a concrete path is admitted by a pattern.
 *
 * Length-equal and segment-wise, with no prefix matching: `user` does **not**
 * admit `user.email`. Prefix matching is the one behaviour an allowlist must
 * not have — it turns allowing a field into allowing every field anybody later
 * nests underneath it, which is how an allowlist decays into a denylist without
 * anyone editing it. Allowing a subtree has to be spelled out, one path at a
 * time, and that friction is the feature.
 */
export function matchesPattern(path: readonly string[], pattern: readonly string[]): boolean {
  if (path.length !== pattern.length) return false;
  return pattern.every((segment, index) => {
    // `*` stands in for a key, never for an array element: `counts.*` should not
    // admit `counts[]`, because a list and a map of dynamic keys are different
    // shapes and an allowlist that conflated them would admit a shape its
    // author never looked at.
    if (segment === WILDCARD_SEGMENT) return path[index] !== ARRAY_SEGMENT;
    return segment === path[index];
  });
}
