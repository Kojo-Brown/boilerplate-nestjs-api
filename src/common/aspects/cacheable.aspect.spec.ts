import { InMemoryAspectCache } from "@/test-utils/in-memory-aspect-cache";
import { AspectUsageError } from "./aspect.types";
import type { AspectContext, AspectInvocation } from "./aspect.types";
import { applyCacheable, resolveCacheableOptions } from "./cacheable.aspect";
import type { CacheableOptions } from "./cacheable.aspect";

const context: AspectContext = { target: "UsersService", method: "findById" };

let cache: InMemoryAspectCache;
let logger: { debug: jest.Mock; warn: jest.Mock };

const wrap = (next: AspectInvocation, options: CacheableOptions = {}): AspectInvocation =>
  applyCacheable(next, context, resolveCacheableOptions(options), { cache, logger });

beforeEach(() => {
  cache = new InMemoryAspectCache();
  logger = { debug: jest.fn(), warn: jest.fn() };
});

describe("resolveCacheableOptions", () => {
  it.each([
    ["a zero ttl", { ttlMs: 0 }],
    ["a negative ttl", { ttlMs: -1 }],
    ["an empty prefix", { keyPrefix: "" }],
  ])("rejects %s at decoration time", (_label, options) => {
    expect(() => resolveCacheableOptions(options)).toThrow(/@Cacheable/);
  });

  it("accepts an omitted ttl, which defers to the store default", () => {
    expect(resolveCacheableOptions({})).toEqual({});
  });
});

describe("applyCacheable", () => {
  it("calls through on a miss and serves the second call from the cache", async () => {
    const next = jest.fn().mockResolvedValue({ id: "a" });
    const call = wrap(next);

    await expect(call(["a"])).resolves.toEqual({ id: "a" });
    await expect(call(["a"])).resolves.toEqual({ id: "a" });
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("keys on the arguments, so a different argument is a different entry", async () => {
    const next = jest
      .fn()
      .mockImplementation((args: readonly unknown[]) => Promise.resolve(args[0]));
    const call = wrap(next);

    await expect(call(["a"])).resolves.toBe("a");
    await expect(call(["b"])).resolves.toBe("b");
    expect(next).toHaveBeenCalledTimes(2);
  });

  it("passes the ttl through to the store", async () => {
    const call = wrap(jest.fn().mockResolvedValue(1), { ttlMs: 30_000, keyPrefix: "users" });

    await call(["a"]);

    expect([...cache.ttls.entries()]).toEqual([['users:UsersService.findById:["a"]', 30_000]]);
  });

  it("caches a resolved undefined instead of re-running the method forever", async () => {
    // The envelope exists for exactly this: `store.get()` cannot tell a cached
    // `undefined` from a miss on its own.
    const next = jest.fn().mockResolvedValue(undefined);
    const call = wrap(next);

    await expect(call(["missing"])).resolves.toBeUndefined();
    await expect(call(["missing"])).resolves.toBeUndefined();
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("does not cache a rejection", async () => {
    const next = jest.fn().mockRejectedValueOnce(new Error("upstream")).mockResolvedValueOnce("ok");
    const call = wrap(next);

    await expect(call(["a"])).rejects.toThrow("upstream");
    await expect(call(["a"])).resolves.toBe("ok");
    expect(cache.writes).toBe(1);
  });

  it("collapses concurrent misses for one key into a single call", async () => {
    let release: (value: string) => void = () => undefined;
    const next = jest.fn().mockImplementation(
      () =>
        new Promise<string>((resolve) => {
          release = resolve;
        }),
    );
    const call = wrap(next);

    const inFlight = [call(["a"]), call(["a"]), call(["a"])];
    // Drain the microtask queue so all three have passed the store lookup and
    // reached the de-duplication point before the underlying call settles.
    await new Promise((resolve) => setImmediate(resolve));
    release("shared");

    await expect(Promise.all(inFlight)).resolves.toEqual(["shared", "shared", "shared"]);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("does not collapse calls for different keys", async () => {
    const next = jest
      .fn()
      .mockImplementation((args: readonly unknown[]) => Promise.resolve(args[0]));
    const call = wrap(next);

    await expect(Promise.all([call(["a"]), call(["b"])])).resolves.toEqual(["a", "b"]);
    expect(next).toHaveBeenCalledTimes(2);
  });

  it("releases the in-flight entry after a failure so the next call retries", async () => {
    const next = jest.fn().mockRejectedValueOnce(new Error("boom")).mockResolvedValueOnce("ok");
    const call = wrap(next);

    await expect(call(["a"])).rejects.toThrow("boom");
    await expect(call(["a"])).resolves.toBe("ok");
    expect(next).toHaveBeenCalledTimes(2);
  });

  it("uses a custom key builder when one is given", async () => {
    const next = jest.fn().mockResolvedValue("ok");
    const call = wrap(next, { key: (args) => `tenant:${String(args[1])}` });

    await call(["ignored", 7]);

    expect([...cache.entries.keys()]).toEqual(["tenant:7"]);
  });

  it("bypasses the cache when the arguments cannot be keyed", async () => {
    const next = jest.fn().mockResolvedValue("ok");
    const call = wrap(next);

    // A callback argument has no stable serialisation, but the call itself is
    // perfectly valid — degrading beats failing it.
    await expect(call([() => undefined])).resolves.toBe("ok");
    await expect(call([() => undefined])).resolves.toBe("ok");
    expect(next).toHaveBeenCalledTimes(2);
    expect(cache.reads).toBe(0);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.debug).toHaveBeenCalledTimes(1);
  });

  it("still answers when the store cannot be read", async () => {
    cache.failReads = true;
    const next = jest.fn().mockResolvedValue("ok");
    const call = wrap(next);

    await expect(call(["a"])).resolves.toBe("ok");
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it("still answers when the store cannot be written", async () => {
    cache.failWrites = true;
    const next = jest.fn().mockResolvedValue("ok");
    const call = wrap(next);

    await expect(call(["a"])).resolves.toBe("ok");
    await expect(call(["a"])).resolves.toBe("ok");
    expect(next).toHaveBeenCalledTimes(2);
  });

  it("refuses a method that does not return a promise", async () => {
    const call = wrap(jest.fn().mockReturnValue("synchronous"));

    await expect(call(["a"])).rejects.toThrow(AspectUsageError);
  });
});
