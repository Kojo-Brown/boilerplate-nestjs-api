import type { DeepReadonly } from "./immutable.types";

/**
 * Recursively freezes a value and returns it.
 *
 * This is a *development* guard: it converts a silent mutation of shared state
 * into a `TypeError` at the moment it happens, rather than a wrong value read
 * somewhere else entirely. It is not a security boundary and not a substitute
 * for the type layer — `DeepReadonly` is what carries the same rule into a
 * production build, where freezing is off.
 *
 * Freezing is what makes structural sharing *safe*. Sharing an untouched
 * subtree between two versions of a value turns "a caller mutated its own
 * copy" into "a caller mutated everyone's copy": the whole point of returning
 * the same reference is that other holders keep it. See
 * [docs/immutability.md](../../../docs/immutability.md).
 *
 * Three properties are load-bearing and are pinned by the spec:
 *
 * 1. **Cycle-safe.** A `WeakSet` of visited objects makes `a.self = a`
 *    terminate. Without it this recurses until the stack runs out, and the
 *    first payload with a back-reference takes the process down.
 * 2. **Accessors are never invoked.** Recursion reads property *descriptors*
 *    and only descends into `value` slots. Walking `Object.values()` instead
 *    would call every getter — running side effects, and hitting whatever a
 *    lazy getter throws — during what is supposed to be an inert traversal.
 * 3. **Unfreezable values are skipped, not attempted.** `Object.freeze` throws
 *    `TypeError: Cannot freeze array buffer views with elements` on any
 *    non-empty `Buffer` or typed array, so a naive implementation crashes on
 *    the first request body carrying binary data.
 *
 * What it deliberately does **not** do: stop `map.set(…)`, `set.add(…)` or
 * `date.setHours(…)`. Those mutate internal slots rather than properties, and
 * no amount of freezing reaches them. They are stopped at compile time by
 * `DeepReadonly` mapping to `ReadonlyMap`/`ReadonlySet`, or not at all.
 */
export function deepFreeze<T>(value: T): DeepReadonly<T> {
  freezeInto(value, new WeakSet<object>());
  return value as DeepReadonly<T>;
}

/**
 * True if `value` and everything reachable from it by data properties is
 * frozen, by the same walk {@link deepFreeze} performs.
 *
 * Exists so a test can assert the guarantee rather than spot-check one field,
 * and so the users-store contract can hold both implementations to it.
 * Mirrors `deepFreeze`'s skip rules exactly: a value `deepFreeze` declines to
 * freeze is not counted as a violation, otherwise the two would disagree about
 * every payload containing a `Buffer`.
 */
export function isDeeplyFrozen(value: unknown): boolean {
  return checkFrozen(value, new WeakSet<object>());
}

/**
 * Values that are left exactly as they are.
 *
 * `ArrayBufferView` (every `Buffer` and typed array) and `ArrayBuffer` cannot
 * be frozen at all once non-empty — the freeze itself throws. Functions are
 * excluded because freezing one breaks the many libraries that hang state off
 * a function object (memoisation caches, `.displayName`, decorator metadata),
 * and a frozen function body can still mutate whatever it closes over, so the
 * freeze buys nothing to offset that. Promises keep their state in internal
 * slots, so freezing is inert.
 */
function isOpaque(value: object): boolean {
  return (
    typeof value === "function" ||
    ArrayBuffer.isView(value) ||
    value instanceof ArrayBuffer ||
    value instanceof Promise
  );
}

/**
 * Values that are frozen but not descended into.
 *
 * Their interesting state lives in internal slots, so there is nothing below
 * them worth walking. They are still frozen, which stops the one thing freezing
 * can stop here: a caller bolting an ad-hoc property onto a shared `Date`.
 */
function isLeaf(value: object): boolean {
  return value instanceof Date || value instanceof RegExp;
}

function freezeInto(value: unknown, seen: WeakSet<object>): void {
  if (value === null || (typeof value !== "object" && typeof value !== "function")) return;

  const target = value as object;
  if (seen.has(target)) return;
  if (isOpaque(target)) return;
  seen.add(target);

  Object.freeze(target);
  if (isLeaf(target)) return;

  // Collections before properties: their entries are reachable state, even
  // though the collection object itself has no property holding them.
  if (target instanceof Map) {
    for (const [key, entry] of target) {
      freezeInto(key, seen);
      freezeInto(entry, seen);
    }
  } else if (target instanceof Set) {
    for (const entry of target) freezeInto(entry, seen);
  }

  // `Reflect.ownKeys` rather than `Object.keys`: a non-enumerable or
  // symbol-keyed property is every bit as mutable as an enumerable one.
  for (const key of Reflect.ownKeys(target)) {
    const descriptor = Object.getOwnPropertyDescriptor(target, key);
    // No `value` slot means an accessor. Reading it would call the getter,
    // which this traversal has no business doing; the accessor itself is
    // already immutable by virtue of the object being frozen.
    if (!descriptor || !("value" in descriptor)) continue;
    freezeInto(descriptor.value, seen);
  }
}

function checkFrozen(value: unknown, seen: WeakSet<object>): boolean {
  if (value === null || (typeof value !== "object" && typeof value !== "function")) return true;

  const target = value as object;
  if (seen.has(target)) return true;
  if (isOpaque(target)) return true;
  seen.add(target);

  if (!Object.isFrozen(target)) return false;
  if (isLeaf(target)) return true;

  if (target instanceof Map) {
    for (const [key, entry] of target) {
      if (!checkFrozen(key, seen) || !checkFrozen(entry, seen)) return false;
    }
  } else if (target instanceof Set) {
    for (const entry of target) {
      if (!checkFrozen(entry, seen)) return false;
    }
  }

  for (const key of Reflect.ownKeys(target)) {
    const descriptor = Object.getOwnPropertyDescriptor(target, key);
    if (!descriptor || !("value" in descriptor)) continue;
    if (!checkFrozen(descriptor.value, seen)) return false;
  }

  return true;
}
