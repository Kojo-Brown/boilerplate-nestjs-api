import { deepFreeze } from "./deep-freeze";

/**
 * Pure update helpers that reuse whatever the update did not touch.
 *
 * Two guarantees, both pinned by the spec, and both about *reference identity*
 * rather than about equality:
 *
 * 1. **A no-op update returns the input itself.** `next === prev`, not merely a
 *    copy that happens to be equal. That turns "did anything actually change?"
 *    into a pointer comparison a caller can act on — skipping a database write,
 *    a cache invalidation or a re-render — with no deep-equality walk and no
 *    dirty flag to keep in sync.
 * 2. **Untouched subtrees keep their identity.** Changing `user.name` leaves
 *    `next.preferences === prev.preferences`, so the same comparison works one
 *    level down.
 *
 * Every helper preserves the frozen-ness of its input: given a frozen value it
 * returns a frozen value. Without that rule the guard would be *conditional on
 * the data*, which is worse than not having it — a no-op update returns the
 * frozen input and throws on a later write, while a real update returns a
 * thawed copy and accepts one. The same code path would then fail only for
 * some inputs, which is precisely the bug class freezing is meant to remove.
 */

/** Re-freezes `next` when `source` was frozen, so frozen-ness is not data-dependent. */
function preserveFrozenness<T>(source: T, next: T): T {
  if (typeof source !== "object" || source === null) return next;
  // `deepFreeze`, not `Object.freeze`: the reused subtrees are already frozen,
  // but the values the caller just supplied are not.
  return Object.isFrozen(source) ? (deepFreeze(next) as T) : next;
}

/**
 * Sets one key, returning `source` unchanged when the value is already there.
 *
 * `Object.is` rather than `===` so that setting `NaN` over `NaN` is correctly a
 * no-op, and setting `-0` over `+0` is correctly a change.
 */
export function setKey<T extends object, K extends keyof T>(source: T, key: K, value: T[K]): T {
  // The `in` check matters when `value` is `undefined`: `Object.is` cannot tell
  // "already undefined" from "absent", and the two differ to `Object.keys`,
  // `JSON.stringify` and Prisma alike.
  if (key in source && Object.is(source[key], value)) return source;

  const next: T = { ...source };
  next[key] = value;
  return preserveFrozenness(source, next);
}

/**
 * Replaces one key with the result of `update`, returning `source` unchanged
 * when `update` returns what it was given.
 *
 * This is how nesting is expressed — `updateKey(user, "preferences", (p) =>
 * patch(p, { theme: "dark" }))` — rather than by a `setIn(obj, ["a","b"], v)`
 * taking a path array. A path array cannot be typed against the object it
 * indexes without giving up either the key names or the value type, and an
 * update helper that types its value as `unknown` writes unchecked data into
 * the middle of a structure. Composed calls stay checked the whole way down,
 * and the no-op rule composes with them: if the innermost `patch` changes
 * nothing, every enclosing `updateKey` returns its own input too.
 */
export function updateKey<T extends object, K extends keyof T>(
  source: T,
  key: K,
  update: (current: T[K]) => T[K],
): T {
  return setKey(source, key, update(source[key]));
}

/**
 * Applies the defined keys of `changes` over `source`.
 *
 * **Keys whose value is `undefined` are ignored**, which is a policy and not an
 * accident. A patch usually arrives as a validated DTO *instance*, and under
 * `target: ES2022` class fields are defined on construction — so a request body
 * of `{"smsNotifications": true}` yields an object with every optional key
 * present and all but one `undefined`. A plain `{...source, ...changes}`
 * therefore overwrites every untouched field with `undefined`: changing one
 * setting silently discards the rest. To set a key *to* `undefined`
 * deliberately, use {@link setKey}, where saying so is the whole call.
 *
 * Returns `source` itself when no defined key differs from what is already
 * there, so a request that asks for the state a resource is already in is
 * distinguishable from one that changes it.
 */
export function patch<T extends object>(source: T, changes: Partial<T>): T {
  const changed: [keyof T, T[keyof T]][] = [];

  for (const key of Object.keys(changes) as (keyof T)[]) {
    const value = changes[key];
    if (value === undefined) continue;
    if (key in source && Object.is(source[key], value)) continue;
    changed.push([key, value as T[keyof T]]);
  }

  if (changed.length === 0) return source;

  const next: T = { ...source };
  for (const [key, value] of changed) next[key] = value;
  return preserveFrozenness(source, next);
}

/** Removes one key, returning `source` unchanged when it is not there. */
export function removeKey<T extends object, K extends keyof T>(source: T, key: K): Omit<T, K> {
  if (!(key in source)) return source;

  const { [key]: _removed, ...rest } = source;
  return preserveFrozenness(source as Omit<T, K>, rest);
}

/**
 * Maps an array, returning `source` unchanged when every element maps to
 * itself.
 *
 * The common case for a collection update is that one element changed, and the
 * elements that did not keep their identity regardless — so a caller holding a
 * reference to an untouched element still holds the live one.
 */
export function mapArray<E>(
  source: readonly E[],
  map: (item: E, index: number) => E,
): readonly E[] {
  let mutated = false;
  const next = source.map((item, index) => {
    const mapped = map(item, index);
    if (!Object.is(mapped, item)) mutated = true;
    return mapped;
  });

  if (!mutated) return source;
  return preserveFrozenness(source, next);
}
