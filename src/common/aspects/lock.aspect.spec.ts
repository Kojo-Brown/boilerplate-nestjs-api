import { InMemoryDistributedLock, LockNotAcquiredError, SystemLockClock } from "@/common/locking";
import type { LockLogger } from "@/common/locking";
import { AspectConfigurationError, AspectUsageError } from "./aspect.types";
import type { AspectContext } from "./aspect.types";
import { applyLock, buildDefaultLockKey, resolveLockOptions } from "./lock.aspect";

const CONTEXT: AspectContext = { target: "OrdersService", method: "capture" };

describe("resolveLockOptions", () => {
  it("defaults to a ten-second lease", () => {
    expect(resolveLockOptions().ttlMs).toBe(10_000);
  });

  it.each([
    ["a zero ttlMs", { ttlMs: 0 }],
    ["a negative ttlMs", { ttlMs: -1 }],
    ["a fractional ttlMs", { ttlMs: 100.5 }],
    ["a negative waitMs", { waitMs: -1 }],
    ["a negative retryDelayMs", { retryDelayMs: -5 }],
    ["a zero maxHoldMs", { maxHoldMs: 0 }],
    ["an empty keyPrefix", { keyPrefix: "" }],
  ])("refuses %s at import time rather than on the first contended call", (_why, options) => {
    expect(() => resolveLockOptions(options)).toThrow(AspectConfigurationError);
  });

  it("refuses a renewal that fires no sooner than the expiry", () => {
    // Such a policy renews nothing: the lease is already gone by the time
    // `extend` reaches Redis, so the lock silently stops being held.
    expect(() => resolveLockOptions({ ttlMs: 1_000, renewIntervalMs: 1_000 })).toThrow(
      /must be below ttlMs/,
    );
  });
});

describe("buildDefaultLockKey", () => {
  it("namespaces by class and method so unrelated services do not serialise", () => {
    expect(buildDefaultLockKey(CONTEXT, ["o-1"])).toBe('lock:OrdersService.capture:["o-1"]');
  });

  it("honours a caller's namespace", () => {
    expect(buildDefaultLockKey(CONTEXT, ["o-1"], "orders")).toBe(
      'orders:OrdersService.capture:["o-1"]',
    );
  });
});

describe("applyLock", () => {
  const clock = new SystemLockClock();
  let lock: InMemoryDistributedLock;
  let logger: LockLogger;

  beforeEach(() => {
    lock = new InMemoryDistributedLock();
    logger = { debug: () => {}, warn: () => {} };
  });

  it("lets one caller through and refuses the other", async () => {
    let running = 0;
    let overlapped = false;
    const invoke = applyLock(
      async () => {
        running += 1;
        overlapped ||= running > 1;
        await new Promise((resolve) => setTimeout(resolve, 30));
        running -= 1;
        return "done";
      },
      CONTEXT,
      resolveLockOptions({ ttlMs: 1_000 }),
      { lock, clock, logger },
    );

    const [first, second] = await Promise.allSettled([invoke(["o-1"]), invoke(["o-1"])]);

    expect(first.status).toBe("fulfilled");
    expect(second.status).toBe("rejected");
    expect((second as PromiseRejectedResult).reason).toBeInstanceOf(LockNotAcquiredError);
    expect(overlapped).toBe(false);
  });

  it("keeps different arguments apart", async () => {
    const invoke = applyLock(async () => "done", CONTEXT, resolveLockOptions({ ttlMs: 1_000 }), {
      lock,
      clock,
      logger,
    });

    await expect(Promise.all([invoke(["o-1"]), invoke(["o-2"])])).resolves.toEqual([
      "done",
      "done",
    ]);
  });

  it("locks on what the caller's key function selects", async () => {
    const invoke = applyLock(
      async () => "done",
      CONTEXT,
      // Two calls that differ only in their second argument still have to
      // exclude each other — which the default key, built from the whole
      // argument list, would not do.
      resolveLockOptions({ ttlMs: 1_000, key: ([orderId]) => `order:${String(orderId)}` }),
      { lock, clock, logger },
    );

    await invoke(["o-1", { attempt: 1 }]);
    await expect(invoke(["o-1", { attempt: 2 }])).resolves.toBe("done");
    expect(await lock.acquire("order:o-1", { ttlMs: 100 })).not.toBeNull();
  });

  it("refuses an unkeyable argument instead of running unlocked", async () => {
    const invoke = applyLock(async () => "done", CONTEXT, resolveLockOptions({ ttlMs: 1_000 }), {
      lock,
      clock,
      logger,
    });

    // `@Cacheable()` degrades to calling through here, because a cache may
    // never turn a working call into a failing one. A lock is the opposite: the
    // caller was written assuming exclusion it would not have.
    await expect(invoke([() => undefined])).rejects.toThrow(/Cannot derive a cache key/);
  });

  it("refuses a method that does not return a promise", async () => {
    const invoke = applyLock(() => "synchronous", CONTEXT, resolveLockOptions({ ttlMs: 1_000 }), {
      lock,
      clock,
      logger,
    });

    await expect(invoke([])).rejects.toBeInstanceOf(AspectUsageError);
  });
});
