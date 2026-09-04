import { Injectable } from "@nestjs/common";
import { CacheService } from "@/common/cache";

/** The admin list endpoint's entry. One key for the whole first page. */
export const USERS_LIST_CACHE_KEY = "v1:users:list";

/** `GET /v1/users/:id`. Also the key `UserResourceCacheInterceptor` writes. */
export const userCacheKey = (id: string) => `v1:users:${id}`;

/** `GET /v1/users/:id/preferences`. */
export const userPreferencesCacheKey = (id: string) => `${userCacheKey(id)}:prefs`;

/**
 * The read model's cache, and the only place that knows its key layout.
 *
 * Under CQRS the read side owns what it caches, so the write side does not name
 * keys — it says *which user moved* and this decides what that invalidates.
 * That is not bookkeeping: preferences are stored on the user row, so a
 * preference write also moves the row's version and therefore invalidates the
 * user representation and the `ETag` on it, and every write of any kind
 * invalidates the list. Having that fan-out written once here is what kept a
 * fourth call site from getting it wrong.
 *
 * Eviction is synchronous from the command handlers rather than driven off the
 * event bus, which is the one deliberate exception to "the read model is
 * updated by events". A client that writes and immediately reads must not be
 * served the value it just replaced, and an eviction that happens a poll later
 * cannot promise that. What *is* event-driven is the eviction no write path can
 * perform — see `UsersReadModelProjector`.
 */
@Injectable()
export class UsersReadModelCache {
  constructor(private readonly cache: CacheService) {}

  /**
   * Drops everything that describes one user, plus the list they appear in.
   *
   * One `delMany` rather than two `del`s: the two keys always move together, so
   * a partial failure between them would leave the pair inconsistent in the way
   * that is hardest to notice — a user whose own representation is fresh and
   * whose row in the list is stale.
   */
  evictUser(id: string): Promise<void> {
    return this.cache.delMany([userCacheKey(id), USERS_LIST_CACHE_KEY]);
  }

  /** Drops the list alone, for a change that adds or removes a row. */
  evictList(): Promise<void> {
    return this.cache.del(USERS_LIST_CACHE_KEY);
  }

  evictPreferences(id: string): Promise<void> {
    return this.cache.del(userPreferencesCacheKey(id));
  }
}
