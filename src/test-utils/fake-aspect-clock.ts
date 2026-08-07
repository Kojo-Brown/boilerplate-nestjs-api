import type { AspectClock, AspectRandom } from "@/common/aspects";

/**
 * A clock the tests drive by hand.
 *
 * `sleep()` resolves immediately and records what it was asked to wait for, so
 * a retry schedule can be asserted exactly without the suite spending the real
 * backoff — and without fake timers, which fight with the promise scheduling
 * the aspects rely on. Time still advances by the slept amount, so `@Timed()`
 * sees a duration that includes the backoff.
 */
export class FakeAspectClock implements AspectClock {
  readonly sleeps: number[] = [];
  private current: number;

  constructor(startAt = 1_000) {
    this.current = startAt;
  }

  now(): number {
    return this.current;
  }

  /** Moves the clock without sleeping, for timing assertions. */
  advance(ms: number): void {
    this.current += ms;
  }

  sleep(ms: number): Promise<void> {
    this.sleeps.push(ms);
    this.current += ms;
    return Promise.resolve();
  }
}

/** Returns the configured fractions in order, then repeats the last one. */
export class FakeAspectRandom implements AspectRandom {
  private index = 0;

  constructor(private readonly fractions: readonly number[] = [0.5]) {}

  nextFraction(): number {
    const fraction = this.fractions[Math.min(this.index, this.fractions.length - 1)] ?? 0;
    this.index += 1;
    return fraction;
  }
}
