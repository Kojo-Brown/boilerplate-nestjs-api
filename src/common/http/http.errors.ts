import { BadGatewayException, ServiceUnavailableException } from "@nestjs/common";

/**
 * The two failures that belong to the transport rather than to the upstream's
 * answer.
 *
 * Both are `HttpException`s for the same reason the payment and notification
 * errors are: `AllExceptionsFilter` renders them with a status that means
 * something, and the alternative is a raw `TypeError` from `fetch` reaching a
 * controller and being reported to the caller as a 500 the service caused.
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
