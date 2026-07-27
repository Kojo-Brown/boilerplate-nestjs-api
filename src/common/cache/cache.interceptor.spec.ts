import { ExecutionContext } from "@nestjs/common";
import { CACHE_KEY_METADATA } from "@nestjs/cache-manager";
import { HttpCacheInterceptor } from "./cache.interceptor";

const makeContext = (
  method: string,
  query: Record<string, string> = {},
  url = "/v1/users",
): ExecutionContext => {
  const req = { method, query, url, originalUrl: url };
  return {
    switchToHttp: () => ({ getRequest: () => req }),
    // The base `trackBy` reads the request off the argument list, not the host.
    getArgByIndex: () => req,
    getHandler: () => function handler() {},
    getClass: () => class Ctrl {},
  } as unknown as ExecutionContext;
};

/** Exposes the two protected members under test. */
type Probe = {
  isRequestCacheable(ctx: ExecutionContext): boolean;
  trackBy(ctx: ExecutionContext): string | undefined;
};

const makeInterceptor = (declaredKey?: string) => {
  const interceptor = new HttpCacheInterceptor(
    { get: jest.fn(), set: jest.fn(), del: jest.fn(), clear: jest.fn() } as never,
    {
      get: jest.fn((metadataKey: unknown) =>
        metadataKey === CACHE_KEY_METADATA ? declaredKey : undefined,
      ),
      getAllAndOverride: jest.fn(),
    } as never,
  );

  // `httpAdapterHost` reaches the base class by property injection, which the
  // plain constructor used here does not perform.
  Object.assign(interceptor, {
    httpAdapterHost: {
      httpAdapter: {
        getRequestMethod: (req: { method: string }) => req.method,
        getRequestUrl: (req: { url: string }) => req.url,
      },
    },
  });

  return interceptor as unknown as Probe;
};

describe("HttpCacheInterceptor.isRequestCacheable", () => {
  let interceptor: Probe;

  beforeEach(() => {
    interceptor = makeInterceptor();
  });

  it("returns true for GET requests", () => {
    expect(interceptor.isRequestCacheable(makeContext("GET"))).toBe(true);
  });

  it.each(["POST", "PUT", "PATCH", "DELETE"])("returns false for %s requests", (method) => {
    expect(interceptor.isRequestCacheable(makeContext(method))).toBe(false);
  });
});

describe("HttpCacheInterceptor.trackBy", () => {
  it("uses the declared @CacheKey when the request has no query parameters", () => {
    const interceptor = makeInterceptor("v1:users:list");
    expect(interceptor.trackBy(makeContext("GET"))).toBe("v1:users:list");
  });

  it("skips the cache for a parameterised request on a route with a declared key", () => {
    const interceptor = makeInterceptor("v1:users:list");
    expect(interceptor.trackBy(makeContext("GET", { limit: "1" }))).toBeUndefined();
  });

  it("skips the cache when a search filter is applied", () => {
    const interceptor = makeInterceptor("v1:users:list");
    expect(interceptor.trackBy(makeContext("GET", { search: "Regular" }))).toBeUndefined();
  });

  it("falls back to URL-based tracking when no @CacheKey is declared", () => {
    const interceptor = makeInterceptor();
    expect(interceptor.trackBy(makeContext("GET", { limit: "1" }, "/v1/users/abc"))).toBe(
      "/v1/users/abc",
    );
  });
});
