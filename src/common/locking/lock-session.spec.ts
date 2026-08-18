import { InMemoryDistributedLock } from "./in-memory-distributed-lock";
import { currentLock, withLock } from "./lock-session";
import { LockLostError, LockNotAcquiredError } from "./locking.errors";
import type { DistributedLock, LockHandle, LockLogger } from "./ports";

const KEY = "orders:o-1";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * The half of `@Lock()` that is not about Redis: what happens to the caller
 * when the lease does not last as long as the work does.
 *
 * Run against `InMemoryDistributedLock` and the real clock, with leases in the
 * tens of milliseconds. A fake clock is the wrong tool here — the renewal loop
 * and the operation race each other through the event loop, and a `sleep()`
 * that resolves instantly turns that race into a spin.
 */
describe("withLock", () => {
  let lock: InMemoryDistributedLock;
  /** Every handle `withLock` was given, so a test can make one misbehave. */
  let handles: LockHandle[];
  let observed: DistributedLock;
  let logged: string[];
  let logger: LockLogger;

  beforeEach(() => {
    lock = new InMemoryDistributedLock();
    handles = [];
    logged = [];
    logger = { debug: (message) => logged.push(message), warn: (message) => logged.push(message) };
    observed = {
      acquire: async (key, options) => {
        const handle = await lock.acquire(key, options);
        if (handle) handles.push(handle);
        return handle;
      },
    };
  });

  it("runs the operation, returns its value, and gives the key back", async () => {
    const result = await withLock(observed, KEY, { ttlMs: 1_000, logger }, async () => "done");

    expect(result).toBe("done");
    expect(await lock.acquire(KEY, { ttlMs: 1_000 })).not.toBeNull();
  });

  it("exposes the fencing token to the operation without changing its signature", async () => {
    const seen = await withLock(observed, KEY, { ttlMs: 1_000, logger }, async () => currentLock());

    expect(seen?.key).toBe(KEY);
    expect(seen?.fencingToken).toBe(handles[0]?.fencingToken);
    // And nothing leaks out of the async context it was run in.
    expect(currentLock()).toBeUndefined();
  });

  it("refuses to run the operation at all when the key is held", async () => {
    await lock.acquire(KEY, { ttlMs: 1_000 });
    const operation = jest.fn();

    await expect(withLock(observed, KEY, { ttlMs: 1_000, logger }, operation)).rejects.toThrow(
      LockNotAcquiredError,
    );
    expect(operation).not.toHaveBeenCalled();
  });

  it("lets the operation's own failure through, and still releases", async () => {
    await expect(
      withLock(observed, KEY, { ttlMs: 1_000, logger }, async () => {
        throw new Error("handler blew up");
      }),
    ).rejects.toThrow("handler blew up");

    // The operation's error is the useful one; a lock that was released
    // cleanly has nothing to add to it.
    expect(await lock.acquire(KEY, { ttlMs: 1_000 })).not.toBeNull();
  });

  describe("renewal", () => {
    it("keeps a short lease alive under a long operation", async () => {
      const result = await withLock(
        observed,
        KEY,
        { ttlMs: 400, renewIntervalMs: 50, logger },
        async () => {
          await delay(600);
          return "finished";
        },
      );

      // Without renewal a 400ms lease under a 600ms operation lapses, and the
      // session refuses to report success — see the next test. The interval is
      // an eighth of the lease rather than a third so that several renewals can
      // be late, as they are on a loaded runner, before one is too late.
      expect(result).toBe("finished");
    });

    it("reports the loss even though the operation succeeded", async () => {
      const promise = withLock(
        observed,
        KEY,
        { ttlMs: 60, renewIntervalMs: 10, logger },
        async () => {
          // Refusing every renewal is what a holder sees when somebody else has
          // taken the key: the work finishes, but not under a lock.
          jest.spyOn(handles[0] as LockHandle, "extend").mockResolvedValue(false);
          await delay(100);
          return "finished";
        },
      );

      await expect(promise).rejects.toThrow(LockLostError);
    });

    it("catches a lease that lapsed with renewal switched off", async () => {
      const promise = withLock(observed, KEY, { ttlMs: 40, renew: false, logger }, async () => {
        await delay(120);
        return "finished";
      });

      await expect(promise).rejects.toThrow(/Lost the distributed lock/);
    });

    it("stops renewing once maxHoldMs is reached", async () => {
      const promise = withLock(
        observed,
        KEY,
        { ttlMs: 60, renewIntervalMs: 10, maxHoldMs: 40, logger },
        async () => {
          await delay(200);
          return "finished";
        },
      );

      // The bound is what gets a lock back from an operation that has wedged;
      // the cost is that a *slow* operation is failed rather than waited for.
      await expect(promise).rejects.toThrow(LockLostError);
    });
  });

  describe("releasing", () => {
    it("says so when there was nothing left to release", async () => {
      await withLock(observed, KEY, { ttlMs: 1_000, logger }, async () => {
        await (handles[0] as LockHandle).release();
        return "done";
      });

      expect(logged.join()).toContain("release-missed");
    });

    it("logs a failed release rather than replacing the operation's result", async () => {
      const result = await withLock(observed, KEY, { ttlMs: 1_000, logger }, async () => {
        jest
          .spyOn(handles[0] as LockHandle, "release")
          .mockRejectedValue(new Error("redis unreachable"));
        return "done";
      });

      // The lease expires on its own, so a cleanup failure is worth a log line
      // and nothing more.
      expect(result).toBe("done");
      expect(logged.join()).toContain("release-failed");
    });
  });
});
