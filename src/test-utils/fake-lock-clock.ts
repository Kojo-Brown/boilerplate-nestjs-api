import type { LockClock } from "@/common/locking";

/**
 * The lock clock, driven by hand.
 *
 * `sleep()` resolves immediately and records what it was asked to wait for, so
 * a retry or renewal schedule can be asserted exactly without the suite
 * spending it — and without fake timers, which fight with the promise
 * scheduling the lock relies on. Time advances by the slept amount, so a lease
 * still lapses when the test says it does.
 *
 * Separate from `FakeAspectClock` because the interface it stands in for is
 * separate: the lock reads a monotonic clock, and conflating the two is exactly
 * the mistake `LockClock` exists to prevent.
 */
export class FakeLockClock implements LockClock {
  readonly sleeps: number[] = [];
  private current: number;

  constructor(startAt = 1_000) {
    this.current = startAt;
  }

  now(): number {
    return this.current;
  }

  /** Moves the clock without sleeping, for expiry assertions. */
  advance(ms: number): void {
    this.current += ms;
  }

  sleep(ms: number): Promise<void> {
    this.sleeps.push(ms);
    this.current += ms;
    return Promise.resolve();
  }
}
