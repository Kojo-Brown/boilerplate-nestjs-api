import { HttpException } from "@nestjs/common";
import {
  AspectConfigurationError,
  AspectUsageError,
  assertPromiseLike,
  describeContext,
} from "./aspect.types";
import type { AspectContext, AspectInvocation, AspectLogger } from "./aspect.types";
import type { AspectClock, AspectRandom } from "./ports";

export type RetryBackoff = "fixed" | "exponential";

export interface RetryOptions {
  /** Total attempts, the first one included. `1` disables retrying. Default 3. */
  attempts?: number;
  /** Base delay before the second attempt, in milliseconds. Default 100. */
  delayMs?: number;
  /** Ceiling applied before jitter. Default 2000. */
  maxDelayMs?: number;
  /** Default `exponential`. */
  backoff?: RetryBackoff;
  /** Multiplier per attempt when `backoff` is `exponential`. Default 2. */
  factor?: number;
  /** Full jitter over the computed delay. Default true. */
  jitter?: boolean;
  /**
   * Decides whether a given failure is worth another attempt. Receives the
   * 1-based number of the attempt that just failed. Default
   * {@link isTransientError}.
   */
  retryIf?: (error: unknown, attempt: number) => boolean;
}

export type ResolvedRetryOptions = Required<RetryOptions>;

export const DEFAULT_RETRY_OPTIONS: Omit<ResolvedRetryOptions, "retryIf"> = {
  attempts: 3,
  delayMs: 100,
  maxDelayMs: 2_000,
  backoff: "exponential",
  factor: 2,
  jitter: true,
};

/**
 * Whether a failure could plausibly succeed on another attempt.
 *
 * The interesting case is `HttpException`, which this API throws for both its
 * own responses and — via the providers in `src/payments` and
 * `src/notifications` — for upstream ones. A 4xx is the caller being wrong:
 * retrying a 400 or a 404 burns the budget and delays the inevitable error by
 * however long the backoff runs. The two exceptions are 408 and 429, which
 * explicitly describe a condition that passes.
 *
 * Everything else — a socket hang-up, a timeout, a `PrismaClientKnownRequestError`
 * — is treated as transient, because the alternative is a whitelist that
 * silently stops retrying whatever it has not heard of.
 */
export function isTransientError(error: unknown): boolean {
  if (error instanceof HttpException) {
    const status = error.getStatus();
    return status >= 500 || status === 408 || status === 429;
  }
  return true;
}

function assertPositive(name: string, value: number, minimum: number, integer: boolean): void {
  const valid = Number.isFinite(value) && value >= minimum && (!integer || Number.isInteger(value));
  if (!valid) {
    throw new AspectConfigurationError(
      `@Retry({ ${name} }) must be ${integer ? "an integer" : "a number"} >= ${minimum}, got ${value}.`,
    );
  }
}

/**
 * Validates and fills in defaults. Called by the decorator, so a bad policy is
 * an error at import time rather than on the first failure in production.
 */
export function resolveRetryOptions(options: RetryOptions = {}): ResolvedRetryOptions {
  const resolved: ResolvedRetryOptions = {
    ...DEFAULT_RETRY_OPTIONS,
    retryIf: isTransientError,
    ...stripUndefined(options),
  };

  assertPositive("attempts", resolved.attempts, 1, true);
  assertPositive("delayMs", resolved.delayMs, 0, false);
  assertPositive("maxDelayMs", resolved.maxDelayMs, 0, false);
  assertPositive("factor", resolved.factor, 1, false);
  if (resolved.maxDelayMs < resolved.delayMs) {
    throw new AspectConfigurationError(
      `@Retry({ maxDelayMs }) (${resolved.maxDelayMs}) must not be below delayMs (${resolved.delayMs}).`,
    );
  }
  return resolved;
}

function stripUndefined(options: RetryOptions): RetryOptions {
  return Object.fromEntries(
    Object.entries(options).filter(([, value]) => value !== undefined),
  ) as RetryOptions;
}

/**
 * Delay before the attempt that follows `attempt` (1-based, the attempt that
 * just failed).
 *
 * Jitter is "full jitter" — a uniform draw over `[0, delay)` rather than a
 * band around it. Backing off without it lines every caller that failed at the
 * same moment up to retry at the same moment, which is how one blip becomes a
 * repeating thundering herd; spreading the retries out is worth more than
 * honouring the nominal delay.
 */
export function computeRetryDelay(
  attempt: number,
  options: ResolvedRetryOptions,
  randomFraction: number,
): number {
  const raw =
    options.backoff === "exponential"
      ? options.delayMs * Math.pow(options.factor, attempt - 1)
      : options.delayMs;
  const capped = Math.min(raw, options.maxDelayMs);
  return Math.round(options.jitter ? capped * randomFraction : capped);
}

export interface RetryDependencies {
  readonly clock: AspectClock;
  readonly random: AspectRandom;
  readonly logger: AspectLogger;
}

export function applyRetry(
  next: AspectInvocation,
  context: AspectContext,
  options: ResolvedRetryOptions,
  deps: RetryDependencies,
): AspectInvocation {
  return async (args) => {
    for (let attempt = 1; ; attempt += 1) {
      try {
        const result = next(args);
        assertPromiseLike(result, context, "Retry");
        return await result;
      } catch (error) {
        // A misapplied decorator is a bug in the code, not a flaky dependency:
        // retrying it just delays the same error by the whole backoff schedule.
        if (error instanceof AspectUsageError) throw error;
        if (attempt >= options.attempts || !options.retryIf(error, attempt)) throw error;

        const delayMs = computeRetryDelay(attempt, options, deps.random.nextFraction());
        deps.logger.debug(
          JSON.stringify({
            aspect: "retry",
            method: describeContext(context),
            attempt,
            of: options.attempts,
            delayMs,
            error: error instanceof Error ? error.message : String(error),
          }),
        );
        await deps.clock.sleep(delayMs);
      }
    }
  };
}
