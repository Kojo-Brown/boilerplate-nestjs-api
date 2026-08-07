import type { AspectContext } from "./aspect.types";

export class UnserializableArgumentError extends Error {
  constructor(what: string) {
    super(`Cannot derive a cache key from ${what}. Pass @Cacheable({ key }) instead.`);
    this.name = "UnserializableArgumentError";
  }
}

function reject(what: string): never {
  throw new UnserializableArgumentError(what);
}

/**
 * Deterministic serialisation of an argument list.
 *
 * `JSON.stringify` is not usable directly: it emits object keys in insertion
 * order, so `findUsers({ role, limit })` and `findUsers({ limit, role })` — the
 * same call — would land on two different cache entries and halve the hit rate
 * for no reason. Keys are therefore sorted at every level.
 *
 * Values JSON cannot round-trip unambiguously are rejected rather than coerced.
 * `undefined` disappearing from an object, or a `Date` and its ISO string
 * colliding, would produce two calls that share a key without sharing a result
 * — a wrong answer, which is the one failure mode a cache must never have.
 */
export function stableStringify(value: unknown): string {
  return write(value, new Set());
}

function write(value: unknown, seen: Set<object>): string {
  if (value === null) return "null";

  switch (typeof value) {
    case "undefined":
      return "undefined";
    case "string":
      return JSON.stringify(value);
    case "number":
      return Number.isFinite(value) ? String(value) : reject(`the non-finite number ${value}`);
    case "boolean":
      return String(value);
    case "bigint":
      return `${value}n`;
    case "function":
      return reject("a function argument");
    case "symbol":
      return reject("a symbol argument");
  }

  const object = value as object;
  if (seen.has(object)) reject("a circular reference");
  seen.add(object);
  try {
    if (object instanceof Date) {
      return Number.isNaN(object.getTime())
        ? reject("an invalid Date")
        : `Date(${object.toISOString()})`;
    }
    if (object instanceof RegExp) return `RegExp(${object.source}/${object.flags})`;
    if (object instanceof Map || object instanceof Set) return reject("a Map or Set argument");
    if (object instanceof ArrayBuffer || ArrayBuffer.isView(object)) {
      return reject("a binary argument");
    }
    if (Array.isArray(object)) {
      return `[${object.map((item) => write(item, seen)).join(",")}]`;
    }

    const keys = Object.keys(object).sort();
    const entries = keys.map(
      (key) => `${JSON.stringify(key)}:${write((object as Record<string, unknown>)[key], seen)}`,
    );
    return `{${entries.join(",")}}`;
  } finally {
    seen.delete(object);
  }
}

/**
 * `UsersService.findById:["abc"]` — namespaced by class and method so two
 * services taking the same argument cannot collide, and readable enough to
 * recognise in `redis-cli --scan`.
 */
export function buildDefaultCacheKey(
  context: AspectContext,
  args: readonly unknown[],
  prefix?: string,
): string {
  const name = `${context.target}.${context.method}`;
  return `${prefix ? `${prefix}:` : ""}${name}:${stableStringify(args)}`;
}
