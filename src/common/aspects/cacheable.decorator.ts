import { CACHEABLE_METADATA, defineAspectMetadata } from "./aspect.metadata";
import type { AsyncMethod } from "./aspect.types";
import { resolveCacheableOptions } from "./cacheable.aspect";
import type { CacheableOptions } from "./cacheable.aspect";

/**
 * Memoises a method's resolved value in the application cache.
 *
 * ```ts
 * @Cacheable({ ttlMs: 30_000, keyPrefix: "users" })
 * async findById(id: string): Promise<User | null> { ... }
 * ```
 *
 * Only takes effect on singleton providers — see `AspectWeaver` and
 * `docs/aspects.md`. The `AsyncMethod` constraint means applying this to a
 * synchronous method does not compile: the cache is read asynchronously, so
 * such a method would start returning a promise to callers expecting a value.
 *
 * Invalidation is the caller's job: hold the `keyPrefix`, and delete through
 * `CacheService` when the underlying data changes.
 */
export function Cacheable(options: CacheableOptions = {}) {
  const resolved = resolveCacheableOptions(options);

  return <T extends AsyncMethod>(
    target: object,
    propertyKey: string | symbol,
    _descriptor: TypedPropertyDescriptor<T>,
  ): void => {
    defineAspectMetadata(CACHEABLE_METADATA, resolved, target, propertyKey);
  };
}
