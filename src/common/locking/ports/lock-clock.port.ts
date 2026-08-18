import { performance } from "node:perf_hooks";

/**
 * The only source of time the distributed lock is allowed to read.
 *
 * Deliberately not {@link AspectClock}, whose `now()` is `Date.now()`. Redlock
 * decides whether it still holds a lock by subtracting two readings, and
 * `Date.now()` is the wall clock: NTP steps it, a VM resuming from a snapshot
 * steps it, and an operator can step it by hand. A backwards jump makes an
 * elapsed measurement negative and inflates the computed validity, which is the
 * one arithmetic error in this file that hands two callers the same lock.
 *
 * `performance.now()` is monotonic within the process and is the reading every
 * validity calculation here is made against — which is also why `validUntil` on
 * a handle is meaningless outside this process and is never serialised.
 */
export interface LockClock {
  /** Monotonic milliseconds. Only differences are ever used. */
  now(): number;
  sleep(ms: number): Promise<void>;
}

export class SystemLockClock implements LockClock {
  now(): number {
    return performance.now();
  }

  sleep(ms: number): Promise<void> {
    if (ms <= 0) return Promise.resolve();
    return new Promise((resolve) => {
      // `unref()` so a retry backoff, or a renewal loop waiting out its
      // interval, is never the reason a process refuses to exit.
      const timer = setTimeout(resolve, ms);
      timer.unref?.();
    });
  }
}

/**
 * Jitter for the retry backoff, kept behind a function so a test can pin the
 * sequence it produces. Uniform over `[0, 1)`, like `Math.random`.
 */
export type LockRandom = () => number;
