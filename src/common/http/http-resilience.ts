import type { BackoffPolicy } from "@/common/backoff";
import type { BulkheadPolicy } from "@/common/bulkhead";

/**
 * The knobs the breaker is built from, named for what they do rather than for
 * opossum's option names — the client translates.
 */
export interface CircuitBreakerPolicy {
  /**
   * Share of failed calls in the rolling window, as a percentage, above which
   * the breaker opens.
   */
  readonly failureThresholdPercent: number;
  /**
   * Calls the window must contain before the percentage means anything.
   *
   * Without it, the first call of a quiet minute failing is a 100% failure
   * rate and opens the breaker on a sample of one.
   */
  readonly volumeThreshold: number;
  /** How much history the percentage is computed over. */
  readonly rollingWindowMs: number;
  /**
   * How many buckets that window is divided into. The window advances a bucket
   * at a time, so more buckets means the window slides more smoothly and costs
   * one more timer.
   */
  readonly rollingBuckets: number;
  /** How long an open breaker rejects calls before admitting a single probe. */
  readonly resetTimeoutMs: number;
}

/** Ladder, breaker, bulkhead and deadline: one policy, shared by every dependency. */
export interface HttpResiliencePolicy {
  /**
   * The retry ladder. `maxAttempts` counts the first attempt, so `1` disables
   * retrying without disabling the breaker.
   */
  readonly retry: BackoffPolicy;
  readonly breaker: CircuitBreakerPolicy;
  /**
   * The concurrency cap, per dependency. One slow dependency may hold this
   * many calls open and queue this many more; everything beyond that is
   * refused without being sent.
   */
  readonly bulkhead: BulkheadPolicy;
  /**
   * Hard ceiling on one `request()` call, covering everything it can spend
   * time on: waiting for a bulkhead permit, every attempt, and every sleep
   * between them.
   *
   * The per-attempt timeout ({@link HttpRequestOptions.timeoutMs}) bounds one
   * socket; this bounds the call. Without it, three attempts at a ten-second
   * timeout plus their backoff is over thirty seconds of somebody else's
   * budget, which is how a caller with a ten-second deadline of its own ends
   * up abandoning a request that is still running.
   */
  readonly deadlineMs: number;
}

/**
 * The policy plus the three seams a test needs to make the ladder and the
 * deadline deterministic.
 *
 * All default to the real thing in {@link ResilientHttpModule}; a spec passes
 * a counting `sleep`, a fixed `random` and a clock it advances itself, so it
 * can assert on the schedule instead of waiting for it.
 */
export interface ResilientHttpOptions extends HttpResiliencePolicy {
  readonly sleep: (ms: number) => Promise<void>;
  readonly random: () => number;
  /**
   * Milliseconds from an arbitrary origin, used only for deadline arithmetic.
   *
   * Monotonic in production (`performance.now()`), because the alternative is
   * a deadline that an NTP step can expire early or extend indefinitely. It is
   * never formatted or persisted, so having no relation to wall-clock time
   * costs nothing.
   */
  readonly now: () => number;
}

/** Injection token for {@link ResilientHttpOptions}. */
export const HTTP_RESILIENCE_OPTIONS = Symbol("HTTP_RESILIENCE_OPTIONS");

/** Per-call overrides. Everything else comes from the policy. */
export interface HttpRequestOptions {
  /**
   * Overrides {@link DEFAULT_HTTP_TIMEOUT_MS} for one attempt.
   *
   * It is a ceiling, not a guarantee: an attempt is given whatever is smaller,
   * this or what is left of {@link deadlineMs}. A ten-second attempt inside a
   * budget with two seconds left gets two.
   */
  readonly timeoutMs?: number;
  /**
   * Overrides {@link HttpResiliencePolicy.deadlineMs} for this call — the hard
   * ceiling on the whole thing, queue wait and retries included.
   *
   * Pass it when the caller already has a deadline of its own. A saga step is
   * bounded by `SAGA_STEP_TIMEOUT_MS`, and a step that abandons a request
   * still running upstream has spent its budget without learning the outcome;
   * handing the same number down means the client gives up first and says so.
   */
  readonly deadlineMs?: number;
  /**
   * Whether sending this request twice is harmless.
   *
   * Defaults to whether the method is safe by RFC 9110 — `GET`, `HEAD` and
   * `OPTIONS` are, everything else is not — and a `POST` must opt in
   * explicitly. The bar for opting in is an idempotency key on the request
   * (`Idempotency-Key` at Stripe, `PayPal-Request-Id` at PayPal) or an
   * operation that creates nothing, such as minting an OAuth token.
   *
   * It is not a formality. A retry happens exactly when the outcome of the
   * first attempt is unknown — a socket died, a gateway answered 502 — which
   * is the case where the upstream may well have processed it. Retrying a
   * keyless `POST /v1/refunds` refunds twice; retrying a Twilio message sends
   * two texts. Those calls get the breaker and no ladder.
   */
  readonly idempotent?: boolean;
}

/**
 * Statuses that describe a condition that can pass, so they are worth another
 * attempt and count against the breaker.
 *
 * 408 and 429 are the two 4xx that say "later" rather than "never"; everything
 * else in the 4xx range is this service sending something wrong, and retrying
 * it burns the ladder to arrive at the same answer. That is also why they must
 * not open the breaker: a run of 404s from `find()` is a healthy dependency
 * answering correctly, and taking the integration out over it would be the
 * breaker causing the outage.
 */
export function isRetryableStatus(status: number): boolean {
  return status >= 500 || status === 408 || status === 429;
}

/** Whether a method may be replayed without being told it is safe to. */
export function isSafeMethod(method: string | undefined): boolean {
  const normalised = (method ?? "GET").toUpperCase();
  return normalised === "GET" || normalised === "HEAD" || normalised === "OPTIONS";
}
