import { Reflector } from "@nestjs/core";
import type { ExecutionContext } from "@nestjs/common";
import { UserResourceCacheInterceptor } from "./user-resource.cache.interceptor";
import { userCacheKey } from "./read/users-read-model.cache";

/**
 * `trackBy` is `protected`, which is exactly the surface a subclass exists to
 * override — reaching it through a cast keeps the production signature honest
 * rather than widening it for the test.
 */
type Trackable = { trackBy(context: ExecutionContext): string | undefined };

function contextFor(params: Record<string, string>, method = "GET"): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => ({ params, method, query: {} }) }),
    getHandler: () => () => undefined,
    getClass: () => class {},
  } as unknown as ExecutionContext;
}

describe("UserResourceCacheInterceptor", () => {
  let trackBy: Trackable["trackBy"];

  beforeEach(() => {
    const interceptor = new UserResourceCacheInterceptor(
      { get: jest.fn(), set: jest.fn(), del: jest.fn() },
      new Reflector(),
    );
    trackBy = (context: ExecutionContext) => (interceptor as unknown as Trackable).trackBy(context);
  });

  it("keys the entry by the id in the route", () => {
    expect(trackBy(contextFor({ id: "clx123" }))).toBe(userCacheKey("clx123"));
  });

  // The whole point of the subclass. The base interceptor tracks by request
  // URL — `/v1/users/clx123` — while `UsersReadModelCache.evictUser` deletes
  // `v1:users:clx123`, so nothing a write evicted was ever what a read had
  // stored, and the stale read went on serving a stale ETag for the full TTL.
  it("produces exactly the key the read model's cache invalidates", () => {
    expect(trackBy(contextFor({ id: "clx123" }))).toBe("v1:users:clx123");
  });

  it("gives two users two entries", () => {
    expect(trackBy(contextFor({ id: "a" }))).not.toBe(trackBy(contextFor({ id: "b" })));
  });

  it("skips the cache rather than inventing a key when there is no id", () => {
    expect(trackBy(contextFor({}))).toBeUndefined();
  });
});
