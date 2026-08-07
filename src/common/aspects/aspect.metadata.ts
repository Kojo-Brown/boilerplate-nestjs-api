import "reflect-metadata";

/**
 * The aspect decorators do nothing but record intent under these keys.
 *
 * Nothing is wrapped at decoration time: `@Cacheable()` needs a cache and
 * `@Retry()` needs a clock, and neither exists yet when a class body is
 * evaluated at import time. `AspectWeaver` reads this metadata back once the
 * container is up and installs the behaviour then, which is what keeps the
 * decorators free of any dependency on how the app is wired.
 *
 * `Reflect.getMetadata` walks the prototype chain for the same property key, so
 * a subclass that overrides a decorated method inherits its aspects. That is
 * deliberate: an override is expected to honour the contract of what it
 * replaces, and silently dropping the cache or the retry policy on a subclass
 * would be a surprising way to break it.
 */
export const CACHEABLE_METADATA = Symbol("aspect:cacheable");
export const RETRY_METADATA = Symbol("aspect:retry");
export const TIMED_METADATA = Symbol("aspect:timed");

const ASPECT_METADATA_KEYS: readonly symbol[] = [
  CACHEABLE_METADATA,
  RETRY_METADATA,
  TIMED_METADATA,
];

export function defineAspectMetadata(
  key: symbol,
  value: unknown,
  prototype: object,
  method: string | symbol,
): void {
  Reflect.defineMetadata(key, value, prototype, method);
}

export function readAspectMetadata<T>(
  key: symbol,
  prototype: object,
  method: string | symbol,
): T | undefined {
  return Reflect.getMetadata(key, prototype, method) as T | undefined;
}

/** Used by the weaver to decide whether a method is worth wrapping at all. */
export function hasAspectMetadata(prototype: object, method: string | symbol): boolean {
  return ASPECT_METADATA_KEYS.some((key) => Reflect.hasMetadata(key, prototype, method));
}
