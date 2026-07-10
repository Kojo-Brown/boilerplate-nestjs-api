import { ExecutionContext } from "@nestjs/common";
import { HttpCacheInterceptor } from "./cache.interceptor";

const makeContext = (method: string): ExecutionContext => {
  return {
    switchToHttp: () => ({
      getRequest: () => ({ method }),
    }),
  } as unknown as ExecutionContext;
};

describe("HttpCacheInterceptor.isRequestCacheable", () => {
  let interceptor: HttpCacheInterceptor;

  beforeEach(() => {
    interceptor = new HttpCacheInterceptor(
      { get: jest.fn(), set: jest.fn(), del: jest.fn(), reset: jest.fn() } as never,
      { getAllAndOverride: jest.fn() } as never,
      { httpAdapter: {} } as never,
    );
  });

  it("returns true for GET requests", () => {
    // Access protected method via any cast for testing
    const result = (interceptor as unknown as { isRequestCacheable(ctx: ExecutionContext): boolean })
      .isRequestCacheable(makeContext("GET"));
    expect(result).toBe(true);
  });

  it.each(["POST", "PUT", "PATCH", "DELETE"])(
    "returns false for %s requests",
    (method) => {
      const result = (interceptor as unknown as { isRequestCacheable(ctx: ExecutionContext): boolean })
        .isRequestCacheable(makeContext(method));
      expect(result).toBe(false);
    },
  );
});
