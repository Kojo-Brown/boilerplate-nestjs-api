import { Injectable } from "@nestjs/common";

export const ASPECT_RANDOM = Symbol("ASPECT_RANDOM");

/**
 * Randomness for retry jitter, kept behind a port for the same reason as the
 * clock: a backoff schedule that cannot be predicted cannot be asserted on.
 *
 * Separate from {@link AspectClock} rather than folded into it because the two
 * have different fakes — a test that pins the delay sequence usually wants a
 * real-ish clock, and a test that asserts on elapsed time does not care about
 * jitter at all.
 */
export interface AspectRandom {
  /** A value in `[0, 1)`. */
  nextFraction(): number;
}

@Injectable()
export class SystemAspectRandom implements AspectRandom {
  nextFraction(): number {
    return Math.random();
  }
}
