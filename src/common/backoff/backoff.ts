/**
 * Full-jitter exponential backoff, shared by every retry ladder in the service.
 *
 * It lives in `common/` rather than next to its first caller because there are
 * now two ladders with the same shape and opposite lifetimes: the outbox relay's
 * runs across processes, one attempt per poll, with the schedule persisted in a
 * `nextAttemptAt` column; the domain-event consumer's runs inside a single
 * handler call and is gone if the process dies. What they share is the formula,
 * and one copy of it is what keeps a fix to the jitter from landing in only one.
 */

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

/**
 * The longest a policy can spend *sleeping* before its attempts are spent.
 *
 * The sum of the un-jittered ceilings, so it is an upper bound rather than an
 * expectation — full jitter draws uniformly below each ceiling, which makes the
 * average roughly half this. It exists for the caller that has to fit a whole
 * ladder inside somebody else's deadline: `DomainEventConsumer`'s ladder runs
 * inside one `handle()` call, and `handle()` is bounded by
 * `KAFKA_HANDLER_TIMEOUT_MS`. A ladder whose sleeps alone outlast that bound can
 * never reach its last attempt, so the message is redelivered by the broker
 * instead and never reaches the dead-letter topic — the exact failure the ladder
 * was configured to end. `env.schema.ts` refuses that combination at boot using
 * this function.
 *
 * Time spent *in* the attempts is not included and cannot be: it is however long
 * the handler takes. This is the necessary condition, not the sufficient one.
 */
export function worstCaseLadderMs(policy: BackoffPolicy): number {
  let total = 0;
  for (let attempts = 1; attempts < policy.maxAttempts; attempts += 1) {
    const exponent = Math.min(attempts - 1, 30);
    total += Math.min(policy.maxMs, policy.baseMs * 2 ** exponent);
  }
  return total;
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
