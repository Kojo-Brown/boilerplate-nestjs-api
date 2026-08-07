import { Injectable } from "@nestjs/common";

export const ASPECT_CLOCK = Symbol("ASPECT_CLOCK");

/**
 * The only source of time the aspects are allowed to read.
 *
 * `@Retry()` sleeps between attempts and `@Timed()` measures how long a call
 * took; both are behaviours a test needs to assert on, and neither is testable
 * against the real clock without either sleeping for real or reaching for fake
 * timers — which fight with the promise scheduling these aspects depend on.
 * Injecting the clock lets a test hand over a fake that records the delays it
 * was asked for and returns immediately.
 */
export interface AspectClock {
  /** Monotonic-enough millisecond reading; only differences are ever used. */
  now(): number;
  sleep(ms: number): Promise<void>;
}

@Injectable()
export class SystemAspectClock implements AspectClock {
  now(): number {
    return Date.now();
  }

  sleep(ms: number): Promise<void> {
    if (ms <= 0) return Promise.resolve();
    return new Promise((resolve) => {
      // `unref()` keeps a pending retry backoff from holding the process open
      // during shutdown: the call still finishes if the app is alive, but a
      // sleeping retry alone is not a reason to stay up.
      const timer = setTimeout(resolve, ms);
      timer.unref?.();
    });
  }
}
