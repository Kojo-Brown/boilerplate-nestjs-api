import { FakeLockClock } from "@/test-utils/fake-lock-clock";
import { InMemoryDistributedLock } from "./in-memory-distributed-lock";

/**
 * What the shared contract cannot reach, which for this implementation is
 * mostly its own honesty: it is a `Map`, and the interesting question is
 * whether it behaves like a lock rather than like a stub that says yes.
 */
describe("InMemoryDistributedLock", () => {
  it.each([
    ["zero", 0],
    ["negative", -1],
    ["fractional", 12.5],
  ])("refuses a %s ttlMs rather than locking for an unknown time", async (_why, ttlMs) => {
    await expect(new InMemoryDistributedLock().acquire("k", { ttlMs })).rejects.toBeInstanceOf(
      RangeError,
    );
  });

  it("expires against the clock rather than against a timer", async () => {
    // A timer would not fire in a process that was stopped, and "stopped for
    // longer than the lease" is the exact condition the lease exists for. The
    // Redis implementation gets this from `PX`; here it is a comparison.
    const clock = new FakeLockClock();
    const lock = new InMemoryDistributedLock({ clock });
    await lock.acquire("k", { ttlMs: 1_000 });

    expect(await lock.acquire("k", { ttlMs: 1_000 })).toBeNull();
    clock.advance(1_001);
    expect(await lock.acquire("k", { ttlMs: 1_000 })).not.toBeNull();
  });

  it("waits for a key while the holder's lease runs out", async () => {
    const clock = new FakeLockClock();
    const lock = new InMemoryDistributedLock({ clock, random: () => 1 });
    await lock.acquire("k", { ttlMs: 300 });

    const held = await lock.acquire("k", { ttlMs: 1_000, waitMs: 1_000, retryDelayMs: 100 });

    expect(held).not.toBeNull();
    expect(clock.sleeps).toEqual([100, 100, 100]);
  });

  it("drops everything on clear(), which is what a test suite needs of it", async () => {
    const lock = new InMemoryDistributedLock();
    await lock.acquire("k", { ttlMs: 60_000 });

    lock.clear();

    expect(await lock.acquire("k", { ttlMs: 1_000 })).not.toBeNull();
  });
});
