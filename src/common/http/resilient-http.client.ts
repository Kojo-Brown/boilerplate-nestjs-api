import { Inject, Injectable, Logger } from "@nestjs/common";
import type { OnApplicationShutdown } from "@nestjs/common";
import CircuitBreaker from "opossum";
import { nextAttemptDelayMs } from "@/common/backoff";
import type { BackoffPolicy } from "@/common/backoff";
import { HttpCircuitOpenError, HttpTransportError } from "./http.errors";
import {
  HTTP_RESILIENCE_OPTIONS,
  isRetryableStatus,
  isSafeMethod,
  type HttpRequestOptions,
  type ResilientHttpOptions,
} from "./http-resilience";
import { DEFAULT_HTTP_TIMEOUT_MS, requestJson } from "./json-http";
import type { HttpJsonResponse } from "./json-http";

/** What `snapshot()` reports, for a health indicator or a metrics scrape. */
export interface HttpDependencySnapshot {
  readonly dependency: string;
  readonly state: "closed" | "open" | "half-open";
  readonly successes: number;
  readonly failures: number;
  /** Calls the open breaker refused without sending. */
  readonly rejects: number;
}

/** The arguments the breaker's action takes, in `fire()` order. */
type Attempt = [url: string, init: RequestInit, timeoutMs: number];

/**
 * A response the upstream gave that the ladder and the breaker both count as a
 * failure — a 5xx, a 408, a 429.
 *
 * It carries the response rather than replacing it because of what happens when
 * the ladder is spent: the caller gets that last response back, unchanged, and
 * decides what a 503 from this endpoint means. Turning it into a thrown error
 * would move that decision out of the adapters, where four of them read the
 * upstream's error body to tell a declined card from a dead gateway.
 */
class RetryableResponseError extends Error {
  constructor(readonly response: HttpJsonResponse) {
    super(`Upstream responded ${response.status}`);
    this.name = "RetryableResponseError";
  }
}

/**
 * Every outbound HTTP call in the service, with a circuit breaker in front of
 * it and a full-jitter retry ladder around it.
 *
 * **Why the breaker is per dependency.** One breaker for "outbound HTTP" would
 * let Twilio being down stop payments. The client keeps one breaker per
 * `dependency` string — the adapter's own name, so `stripe`, `paypal`, `sms`
 * and `push` — and each opens and closes on its own history.
 *
 * **Why the ladder is outside the breaker.** The breaker wraps one attempt, so
 * every attempt is counted; the ladder sits outside it and stops the moment the
 * breaker opens. Nesting them the other way would let one call's three attempts
 * be recorded as a single failure, which is a third of the evidence the
 * threshold is calibrated for, and a caller would keep retrying against an open
 * breaker until its budget ran out.
 *
 * **Why some calls are not retried at all.** See `idempotent` on
 * {@link HttpRequestOptions}: a retry is a second attempt at a request whose
 * first outcome is unknown, so anything that moves money or sends a message
 * without an idempotency key gets the breaker and one attempt.
 *
 * **What it does not do.** There is no per-dependency concurrency cap here: a
 * slow dependency can still tie up as many callers as arrive during the
 * timeout. Bulkheads are the next item in the spec, and opossum's `capacity`
 * option is where they will go.
 */
@Injectable()
export class ResilientHttpClient implements OnApplicationShutdown {
  private readonly logger = new Logger(ResilientHttpClient.name);
  private readonly breakers = new Map<string, CircuitBreaker<Attempt, HttpJsonResponse>>();

  constructor(@Inject(HTTP_RESILIENCE_OPTIONS) private readonly options: ResilientHttpOptions) {}

  /**
   * Sends a request through `dependency`'s breaker, retrying if the policy and
   * the failure allow it.
   *
   * Keeps `requestJson`'s contract: a status is data and comes back as an
   * `HttpJsonResponse` whatever it is, including after the ladder is spent.
   * Only a request that produced no response at all throws — as
   * {@link HttpTransportError}, or as {@link HttpCircuitOpenError} when the
   * breaker refused to send it.
   */
  async request(
    dependency: string,
    url: string,
    init: RequestInit,
    options: HttpRequestOptions = {},
  ): Promise<HttpJsonResponse> {
    const breaker = this.breakerFor(dependency);
    const timeoutMs = options.timeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS;
    const ladder: BackoffPolicy = {
      ...this.options.retry,
      maxAttempts:
        (options.idempotent ?? isSafeMethod(init.method)) ? this.options.retry.maxAttempts : 1,
    };

    for (let attempt = 1; ; attempt += 1) {
      try {
        return await breaker.fire(url, init, timeoutMs);
      } catch (caught) {
        if (isBreakerOpen(caught)) {
          // Not a failure of this call — it never happened. Retrying here would
          // spend the ladder on rejections that cost nothing and tell us
          // nothing; the breaker's own reset timeout is the wait that matters.
          throw new HttpCircuitOpenError(dependency, this.options.breaker.resetTimeoutMs);
        }

        const response = caught instanceof RetryableResponseError ? caught.response : null;
        const delayMs = this.delayFor(attempt, ladder, response?.retryAfterMs ?? null);

        if (delayMs === null) {
          if (response !== null) return response;
          throw new HttpTransportError(dependency, attempt, caught);
        }

        this.logger.debug(
          `Retrying ${init.method ?? "GET"} ${url} against "${dependency}" in ${delayMs}ms ` +
            `(attempt ${attempt} of ${ladder.maxAttempts} failed: ${describeFailure(caught)})`,
        );
        await this.options.sleep(delayMs);
      }
    }
  }

  /** Current breaker state per dependency. Empty until the first call is made. */
  snapshot(): readonly HttpDependencySnapshot[] {
    return [...this.breakers.entries()].map(([dependency, breaker]) => ({
      dependency,
      state: breaker.opened ? "open" : breaker.halfOpen ? "half-open" : "closed",
      successes: breaker.stats.successes,
      failures: breaker.stats.failures,
      rejects: breaker.stats.rejects,
    }));
  }

  /**
   * Stops the breakers' rolling-window timers.
   *
   * They are `unref`ed, so a forgotten breaker would not hold the process open
   * — but a Jest worker that keeps rotating buckets after its suite finished is
   * still doing work nobody asked for, and `shutdown()` is how opossum is told
   * the circuit is done.
   */
  onApplicationShutdown(): void {
    for (const breaker of this.breakers.values()) breaker.shutdown();
    this.breakers.clear();
  }

  /**
   * How long to wait before the next attempt, or `null` when there is not going
   * to be one.
   *
   * With no `Retry-After`, this is the shared full-jitter ladder from
   * `common/backoff` — the same formula the outbox relay and the Kafka consumer
   * use, for the same reason: an upstream that fails every in-flight request at
   * once must not get all of them back in the same millisecond.
   *
   * With a `Retry-After`, the upstream's number wins, because it knows when its
   * rate-limit window rolls over and we are guessing. A jitter draw over
   * `baseMs` is still added on top: every client throttled in the same second
   * gets the same hint, so obeying it exactly rebuilds the herd that the ladder
   * exists to break up. A hint longer than the ladder's own ceiling ends the
   * ladder instead — the caller is waiting on a request, and parking it for the
   * five minutes a rate limiter can ask for is a worse answer than a 429 it can
   * act on.
   */
  private delayFor(
    attempt: number,
    ladder: BackoffPolicy,
    retryAfterMs: number | null,
  ): number | null {
    const jittered = nextAttemptDelayMs(attempt, ladder, this.options.random);
    if (jittered === null) return null;
    if (retryAfterMs === null) return jittered;
    if (retryAfterMs > ladder.maxMs) return null;
    return retryAfterMs + Math.floor(this.options.random() * ladder.baseMs);
  }

  private breakerFor(dependency: string): CircuitBreaker<Attempt, HttpJsonResponse> {
    const existing = this.breakers.get(dependency);
    if (existing) return existing;

    const { breaker: policy } = this.options;
    const created = new CircuitBreaker<Attempt, HttpJsonResponse>(attemptRequest, {
      name: dependency,
      // The request already carries `AbortSignal.timeout`, which aborts the
      // socket. Opossum's own timer only stops *waiting* for the promise: the
      // request stays in flight, its side effect still happens, and the
      // connection is still held. Two deadlines where one of them cannot
      // cancel anything is how a "timed out" call ends up having succeeded.
      timeout: false,
      errorThresholdPercentage: policy.failureThresholdPercent,
      volumeThreshold: policy.volumeThreshold,
      rollingCountTimeout: policy.rollingWindowMs,
      rollingCountBuckets: policy.rollingBuckets,
      resetTimeout: policy.resetTimeoutMs,
    });

    created.on("open", () =>
      this.logger.error(
        `Circuit for "${dependency}" opened: more than ${policy.failureThresholdPercent}% of the ` +
          `last ${policy.rollingWindowMs}ms of calls failed. Rejecting for ` +
          `${policy.resetTimeoutMs}ms.`,
      ),
    );
    created.on("halfOpen", () =>
      this.logger.warn(`Circuit for "${dependency}" is half-open: letting one probe through.`),
    );
    created.on("close", () => this.logger.log(`Circuit for "${dependency}" closed.`));

    this.breakers.set(dependency, created);
    return created;
  }
}

/**
 * One attempt, as the breaker sees it: a rejection is a failure against the
 * threshold and anything returned is a success.
 *
 * The classification therefore lives here rather than in an `errorFilter`. A
 * 404 or a 422 returns normally — the dependency answered, promptly and
 * correctly, and it is not the breaker's business that the answer was "no".
 */
async function attemptRequest(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<HttpJsonResponse> {
  const response = await requestJson(url, init, timeoutMs);
  if (!response.ok && isRetryableStatus(response.status)) {
    throw new RetryableResponseError(response);
  }
  return response;
}

/** Opossum rejects with this code, and only this code, when it refuses a call. */
function isBreakerOpen(error: unknown): boolean {
  return error instanceof Error && (error as Error & { code?: string }).code === "EOPENBREAKER";
}

function describeFailure(error: unknown): string {
  if (error instanceof RetryableResponseError) return `HTTP ${error.response.status}`;
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}
