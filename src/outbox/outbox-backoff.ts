/** The knobs the retry ladder is built from. All milliseconds except `maxAttempts`. */
export interface BackoffPolicy {
  /** Delay after the first failure, before jitter. */
  readonly baseMs: number;
  /** Ceiling on the un-jittered delay, so the ladder plateaus instead of running away. */
  readonly maxMs: number;
  /** Attempts a row may make in total. Reaching it dead-letters the row. */
  readonly maxAttempts: number;
}

/**
 * How long to wait before attempt `attempts + 1`, or `null` once attempts are
 * spent.
 *
 * Full jitter — `random(0, min(max, base · 2^n))` — rather than plain
 * exponential backoff, and the reason is specific to a relay. A broker outage
 * fails every claimed row at almost the same instant, so a deterministic ladder
 * schedules every one of them for the same millisecond and the recovery
 * attempt arrives as a thundering herd against a broker that has just come
 * back. Marc Brooker's analysis of the three variants is the standard
 * reference; full jitter is the one that spreads the retries widest for the
 * same expected delay.
 *
 * `random` is a parameter so that a test can pin the schedule. Passing
 * `Math.random` is the production case and is what the relay does.
 */
export function nextAttemptDelayMs(
  attempts: number,
  policy: BackoffPolicy,
  random: () => number,
): number | null {
  if (attempts >= policy.maxAttempts) return null;

  // `attempts` counts failures so far, so the first retry (attempts === 1)
  // waits around `baseMs` rather than around twice it.
  const exponent = Math.min(attempts - 1, 30);
  const ceiling = Math.min(policy.maxMs, policy.baseMs * 2 ** exponent);
  return Math.floor(random() * ceiling);
}

/** {@link nextAttemptDelayMs} as an absolute time, which is what the store stores. */
export function nextAttemptAt(
  now: Date,
  attempts: number,
  policy: BackoffPolicy,
  random: () => number,
): Date | null {
  const delay = nextAttemptDelayMs(attempts, policy, random);
  return delay === null ? null : new Date(now.getTime() + delay);
}
