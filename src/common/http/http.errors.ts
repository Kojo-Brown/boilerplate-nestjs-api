import {
  BadGatewayException,
  GatewayTimeoutException,
  ServiceUnavailableException,
} from "@nestjs/common";
import type { BulkheadRejectedError } from "@/common/bulkhead";

/**
 * The failures that belong to the transport rather than to the upstream's
 * answer: it was never sent, or it never finished.
 *
 * All are `HttpException`s for the same reason the payment and notification
 * errors are: `AllExceptionsFilter` renders them with a status that means
 * something, and the alternative is a raw `TypeError` from `fetch` reaching a
 * controller and being reported to the caller as a 500 the service caused.
 *
 * | Failure                      | Error                        | Status |
 * | ---------------------------- | ---------------------------- | ------ |
 * | Breaker open, not sent       | `HttpCircuitOpenError`       | 503    |
 * | Bulkhead saturated, not sent | `HttpBulkheadRejectedError`  | 503    |
 * | Total budget spent           | `HttpDeadlineExceededError`  | 504    |
 * | Socket died, or timed out    | `HttpTransportError`         | 502    |
 */

/**
 * The circuit for a dependency is open, so the request was never sent.
 *
 * 503 rather than 502: nothing upstream was asked and nothing upstream
 * answered. This is the service declining to make a call it has good reason to
 * believe will fail, and the caller may usefully try again after
 * `retryAfterMs` — which is exactly what a 503 means.
 */
export class HttpCircuitOpenError extends ServiceUnavailableException {
  constructor(
    readonly dependency: string,
    /** How long the breaker waits before letting a probe through. */
    readonly retryAfterMs: number,
  ) {
    super(
      `Circuit breaker for "${dependency}" is open: recent calls failed often enough that ` +
        `requests are being rejected without being sent. The breaker admits a probe in ` +
        `${retryAfterMs}ms.`,
    );
  }
}

/**
 * The dependency's bulkhead is saturated, so the request was never sent.
 *
 * 503 for the same reason the open breaker is one: nothing upstream was asked.
 * This is the service refusing to add another call to a dependency it is
 * already holding `maxConcurrent` calls open against — back-pressure, applied
 * deliberately, and the caller may usefully try again in a moment.
 *
 * It is deliberately distinct from {@link HttpCircuitOpenError} even though
 * both render as a 503: an open breaker says the dependency is failing, a full
 * bulkhead says it is slower than this service has capacity for. Those want
 * different fixes, and a single error would make them indistinguishable in the
 * one place anybody looks — the log line and the response body.
 */
export class HttpBulkheadRejectedError extends ServiceUnavailableException {
  constructor(
    readonly dependency: string,
    /** The primitive's own rejection: which limit was hit, and the caps. */
    override readonly cause: BulkheadRejectedError,
  ) {
    super(
      `Too many concurrent requests to "${dependency}": ${cause.policy.maxConcurrent} are in ` +
        `flight and up to ${cause.policy.maxQueued} may queue for ` +
        `${cause.policy.maxQueueWaitMs}ms. This one was rejected (${cause.reason}) without ` +
        `being sent.`,
    );
  }
}

/**
 * The call ran out of its total budget — {@link HttpResiliencePolicy.deadlineMs}
 * — across the queue wait, the attempts, and the sleeps between them.
 *
 * 504 rather than the 502 a single failed attempt gets: there is an upstream,
 * it was asked, and what went wrong is that it did not answer inside the time
 * this service was willing to spend. `attempts` says how many tries fitted in
 * the budget, which is the difference between a dependency that is slow and one
 * that is failing fast and being retried.
 *
 * Only thrown when the budget expires with no response in hand. A call that has
 * a response — a 503 from the last attempt, say — returns it, because
 * `request()` keeps the contract that a status is data whatever ended the
 * ladder.
 */
export class HttpDeadlineExceededError extends GatewayTimeoutException {
  constructor(
    readonly dependency: string,
    /** The budget that was spent, in milliseconds. */
    readonly deadlineMs: number,
    readonly attempts: number,
    /** The last failure seen before the budget ran out, if there was one. */
    override readonly cause: unknown,
  ) {
    super(
      `Request to "${dependency}" exceeded its ${deadlineMs}ms budget after ${attempts} ` +
        `attempt${attempts === 1 ? "" : "s"}` +
        (cause === undefined ? "." : `: ${describe(cause)}`),
    );
  }
}

/**
 * The request could not be completed at all — DNS, a refused connection, a
 * socket hang-up, or the per-request timeout firing.
 *
 * 502, because there is an upstream and it is the one that could not be
 * reached. `attempts` is on the error rather than only in a log line so the
 * message says whether the retry ladder was spent or the call was never
 * eligible for one.
 */
export class HttpTransportError extends BadGatewayException {
  constructor(
    readonly dependency: string,
    readonly attempts: number,
    /** The `fetch` rejection this wraps: a `TypeError`, or a `TimeoutError`. */
    override readonly cause: unknown,
  ) {
    super(
      `Request to "${dependency}" failed after ${attempts} ` +
        `attempt${attempts === 1 ? "" : "s"}: ${describe(cause)}`,
    );
  }
}

function describe(cause: unknown): string {
  if (cause instanceof Error) {
    // `AbortSignal.timeout` rejects with a DOMException whose message is the
    // unhelpful "The operation was aborted due to timeout"; its name is the
    // part worth keeping, so both are included for every error.
    return `${cause.name}: ${cause.message}`;
  }
  return String(cause);
}
