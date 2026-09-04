import { UserDeletedEvent, UserRegisteredEvent } from "@/cqrs";
import type { CacheService } from "@/common/cache";
import type { DomainEvent } from "@/events";
import { USERS_LIST_CACHE_KEY, UsersReadModelCache, userCacheKey } from "./users-read-model.cache";
import { UsersReadModelProjector } from "./users-read-model.projector";

const registered = (userId = "user-1"): UserRegisteredEvent =>
  new UserRegisteredEvent({
    id: "event-1",
    name: "user.registered",
    occurredAt: "2026-01-01T00:00:00.000Z",
    correlationId: null,
    payload: { userId, email: "erin@example.com", name: "Erin", provider: null },
  } satisfies DomainEvent<"user.registered">);

const deleted = (userId = "user-1"): UserDeletedEvent =>
  new UserDeletedEvent({
    id: "event-2",
    name: "user.deleted",
    occurredAt: "2026-01-01T00:00:00.000Z",
    correlationId: null,
    payload: { userId, email: "erin@example.com" },
  } satisfies DomainEvent<"user.deleted">);

describe("UsersReadModelProjector", () => {
  const cache = {
    get: jest.fn(),
    set: jest.fn(),
    del: jest.fn().mockResolvedValue(undefined),
    delMany: jest.fn().mockResolvedValue(undefined),
    reset: jest.fn(),
  };

  /**
   * `CacheService` holds its `Cache` in a private field, which makes it
   * nominal rather than structural — a double has to be cast in, and doing it
   * once here keeps the cast out of every test body.
   */
  const readModelCache = () => new UsersReadModelCache(cache as unknown as CacheService);

  let projector: UsersReadModelProjector;

  beforeEach(() => {
    jest.resetAllMocks();
    cache.del.mockResolvedValue(undefined);
    cache.delMany.mockResolvedValue(undefined);
    projector = new UsersReadModelProjector(readModelCache());
  });

  /**
   * The bug this projection exists for: registration is `AuthService`'s write,
   * the admin list is the users read model's cache, and before this handler
   * nothing connected the two — a new account was missing from `GET /v1/users`
   * for the full 60s TTL.
   */
  it("evicts the users list when a registration is announced", async () => {
    await projector.handle(registered());

    expect(cache.del).toHaveBeenCalledWith(USERS_LIST_CACHE_KEY);
  });

  it("caches nothing for the new user: there is no representation to warm", async () => {
    await projector.handle(registered());

    expect(cache.set).not.toHaveBeenCalled();
    expect(cache.delMany).not.toHaveBeenCalled();
  });

  it("evicts the deleted user's entry and the list", async () => {
    await projector.handle(deleted("user-7"));

    expect(cache.delMany).toHaveBeenCalledWith([userCacheKey("user-7"), USERS_LIST_CACHE_KEY]);
  });

  /**
   * The delete path already evicted inside its transaction, so on the replica
   * that served the request this runs a second time. Asserted rather than
   * merely tolerated: it is what makes the handler safe to run on *every*
   * replica, which is the only way a delete served elsewhere reaches this one.
   */
  it("is idempotent, so a redelivered event costs an eviction and nothing else", async () => {
    await projector.handle(deleted("user-7"));
    await projector.handle(deleted("user-7"));

    expect(cache.delMany).toHaveBeenNthCalledWith(1, [
      userCacheKey("user-7"),
      USERS_LIST_CACHE_KEY,
    ]);
    expect(cache.delMany).toHaveBeenNthCalledWith(2, [
      userCacheKey("user-7"),
      USERS_LIST_CACHE_KEY,
    ]);
  });
});

describe("UsersReadModelCache", () => {
  const cache = {
    get: jest.fn(),
    set: jest.fn(),
    del: jest.fn().mockResolvedValue(undefined),
    delMany: jest.fn().mockResolvedValue(undefined),
    reset: jest.fn(),
  };

  const readModelCache = () => new UsersReadModelCache(cache as unknown as CacheService);

  beforeEach(() => {
    jest.resetAllMocks();
    cache.del.mockResolvedValue(undefined);
    cache.delMany.mockResolvedValue(undefined);
  });

  it("drops a user and the list together, in one round trip", async () => {
    await readModelCache().evictUser("user-1");

    expect(cache.delMany).toHaveBeenCalledTimes(1);
    expect(cache.delMany).toHaveBeenCalledWith([userCacheKey("user-1"), USERS_LIST_CACHE_KEY]);
  });

  it("keys the preferences entry under the user's own key, so the two evict together", async () => {
    await readModelCache().evictPreferences("user-1");

    expect(cache.del).toHaveBeenCalledWith(`${userCacheKey("user-1")}:prefs`);
  });
});
