export const ASPECT_CACHE = Symbol("ASPECT_CACHE");

/**
 * The slice of the cache `@Cacheable()` needs.
 *
 * `CacheService` satisfies this structurally and is what the app binds to the
 * token, but the aspect is written against the two methods it actually calls so
 * that a test can substitute an in-memory store without standing up
 * `cache-manager` — and so that swapping the cache implementation later is a
 * change in `AppCacheModule` alone.
 */
export interface AspectCacheStore {
  get<T>(key: string): Promise<T | undefined>;
  /** `ttlMs` of `undefined` means "use the store's configured default". */
  set<T>(key: string, value: T, ttlMs?: number): Promise<void>;
}
