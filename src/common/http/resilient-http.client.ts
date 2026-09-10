import { Inject, Injectable, Logger } from "@nestjs/common";
import type { OnApplicationShutdown } from "@nestjs/common";
import CircuitBreaker from "opossum";
import { nextAttemptDelayMs } from "@/common/backoff";
import type { BackoffPolicy } from "@/common/backoff";
import { Bulkhead, BulkheadRejectedError } from "@/common/bulkhead";
import type { BulkheadStats } from "@/common/bulkhead";
import {
  HttpBulkheadRejectedError,
  HttpCircuitOpenError,
  HttpDeadlineExceededError,
  HttpTransportError,
} from "./http.errors";
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
  /**
   * The bulkhead's live occupancy and its cumulative rejections.
   *
   * Reported next to the breaker's counters rather than separately because the
   * two are read together: a dependency with a saturated bulkhead and a closed
   * breaker is slow, and the same bulkhead with an open breaker is a queue of
   * calls waiting to be told the circuit is open.
   */
  readonly bulkhead: BulkheadStats;
}

/** The arguments the breaker's action takes, in `fire()` order. */
type Attempt = [url: string, init: RequestInit, timeoutMs: number];

/** Everything one dependency name owns. Created together, so they cannot diverge. */
interface Dependency {
  readonly breaker: CircuitBreaker<Attempt, HttpJsonResponse>;
  readonly bulkhead: Bulkhead;
}

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
 * **Why there is a bulkhead as well as a breaker.** The breaker reads history,
 * so it can only react to calls that have already finished failing. A
 * dependency answering in nine seconds, just inside its timeout, never produces
 * that history — and every caller arriving inside those nine seconds is
 * admitted, until the process is holding its whole capacity open against one
 * integration. {@link Bulkhead} caps that at `maxConcurrent` in flight plus
 * `maxQueued` waiting, per dependency.
 *
 * **Why the bulkhead is not opossum's `capacity`.** Two reasons, both in
 * opossum 10's `circuit.js`. It calls `semaphore.test()`, which never waits, so
 * there is no queue and a burst one millisecond over the cap is refused
 * outright. And a refusal goes through `handleError`, so it lands in
 * `stats.failures` and counts toward the error percentage: enough local
 * back-pressure would open the breaker and take a *healthy* dependency out for
 * the whole reset timeout. Our own admission decisions must not be evidence
 * about somebody else's health.
 *
 * **Why every call has a deadline.** The per-attempt timeout bounds one socket,
 * not the call: three attempts at ten seconds plus backoff is over half a
 * minute. `deadlineMs` bounds the whole thing — queue wait, attempts, sleeps —
 * and each attempt's socket timeout is clamped to whatever is left of it, so
 * the ceiling is enforced rather than hoped for.
 */
@Injectable()
export class ResilientHttpClient implements OnApplicationShutdown {
  private readonly logger = new Logger(ResilientHttpClient.name);
  private readonly dependencies = new Map<string, Dependency>();

  constructor(@Inject(HTTP_RESILIENCE_OPTIONS) private readonly options: ResilientHttpOptions) {}

  /**
   * Sends a request through `dependency`'s breaker, retrying if the policy and
   * the failure allow it.
   *
   * Keeps `requestJson`'s contract: a status is data and comes back as an
   * `HttpJsonResponse` whatever it is, including after the ladder is spent or
   * the budget ran out. Only a request that produced no response at all
   * throws — as {@link HttpTransportError}, as {@link HttpCircuitOpenError}
   * when the breaker refused to send it, as
   * {@link HttpBulkheadRejectedError} when the dependency's bulkhead was
   * saturated, or as {@link HttpDeadlineExceededError} when the whole budget
   * went without an answer.
   */
  async request(
    dependency: string,
    url: string,
    init: RequestInit,
    options: HttpRequestOptions = {},
  ): Promise<HttpJsonResponse> {
    const { breaker, bulkhead } = this.dependencyFor(dependency);
    const attemptTimeoutMs = options.timeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS;
    const budgetMs = options.deadlineMs ?? this.options.deadlineMs;
    const deadline = this.options.now() + budgetMs;
    const ladder: BackoffPolicy = {
      ...this.options.retry,
      maxAttempts:
        (options.idempotent ?? isSafeMethod(init.method)) ? this.options.retry.maxAttempts : 1,
    };

    /** The last response the ladder counted as a failure, for the deadline paths. */
    let lastResponse: HttpJsonResponse | null = null;

    for (let attempt = 1; ; attempt += 1) {
      const remainingMs = deadline - this.options.now();
      if (remainingMs <= 0) {
        // Reachable only when a sleep overshot: the ladder never schedules one
        // it has no room for. A timer is a floor, not a ceiling, so the case
        // has to be handled rather than reasoned away — and the response that
        // bought the sleep is still the best answer the caller is going to get.
        if (lastResponse !== null) return lastResponse;
        throw new HttpDeadlineExceededError(dependency, budgetMs, attempt - 1, undefined);
      }

      try {
        // The bulkhead is outside the breaker and inside the ladder. Outside
        // the breaker, because a permit is a call this service is holding open
        // and an open breaker holds nothing — and because opossum would file
        // our own back-pressure as the dependency's failures. Inside the
        // ladder, because a backoff sleep holds no socket either: a permit kept
        // across one would cap concurrency below the real figure and let a
        // dependency's own retries crowd out its healthy calls.
        return await bulkhead.run(() => {
          // Re-read the clock rather than reusing `remainingMs`: queueing for a
          // permit spends budget too, and an attempt started with the figure
          // from before the wait is how a "hard" ceiling ends up being the
          // deadline plus however long the queue was.
          const attemptBudgetMs = Math.floor(deadline - this.options.now());
          if (attemptBudgetMs < 1) {
            throw new HttpDeadlineExceededError(dependency, budgetMs, attempt - 1, undefined);
          }
          // Floored, and at least 1: `AbortSignal.timeout` goes to a Node timer,
          // which throws `ERR_OUT_OF_RANGE` on a fractional delay — and a
          // monotonic clock reads in fractions of a millisecond.
          const timeoutMs = Math.max(1, Math.floor(Math.min(attemptTimeoutMs, attemptBudgetMs)));
          return breaker.fire(url, init, timeoutMs);
        }, remainingMs);
      } catch (caught) {
        // The budget is spent, and the ladder is not a way to get more of it.
        if (caught instanceof HttpDeadlineExceededError) throw caught;

        if (caught instanceof BulkheadRejectedError) {
          // Nothing was sent and nothing will be: the ladder would queue again
          // behind the same saturated dependency, spending the caller's budget
          // to arrive at the same answer more slowly.
          throw new HttpBulkheadRejectedError(dependency, caught);
        }

        if (isBreakerOpen(caught)) {
          // Not a failure of this call — it never happened. Retrying here would
          // spend the ladder on rejections that cost nothing and tell us
          // nothing; the breaker's own reset timeout is the wait that matters.
          throw new HttpCircuitOpenError(dependency, this.options.breaker.resetTimeoutMs);
        }

        const response = caught instanceof RetryableResponseError ? caught.response : null;
        if (response !== null) lastResponse = response;
        const delayMs = this.delayFor(attempt, ladder, response?.retryAfterMs ?? null);
        const budgetLeftMs = deadline - this.options.now();

        // Two ways to be done: the ladder is spent, or there is not enough
        // budget left to sleep off the next delay. Either way the caller gets
        // the last response if there is one — the contract does not change
        // depending on which limit ended the call.
        if (delayMs === null || delayMs >= budgetLeftMs) {
          if (response !== null) return response;
          if (delayMs !== null) {
            throw new HttpDeadlineExceededError(dependency, budgetMs, attempt, caught);
          }
          throw new HttpTransportError(dependency, attempt, caught);
        }

        this.logger.debug(
          `Retrying ${init.method ?? "GET"} ${url} against "${dependency}" in ${delayMs}ms ` +
            `(attempt ${attempt} of ${ladder.maxAttempts} failed: ${describeFailure(caught)}; ` +
            `${Math.round(budgetLeftMs)}ms of budget left)`,
        );
        await this.options.sleep(delayMs);
      }
    }
  }

  /**
   * Current breaker state and bulkhead occupancy per dependency. Empty until
   * the first call is made.
   */
  snapshot(): readonly HttpDependencySnapshot[] {
    return [...this.dependencies.entries()].map(([dependency, { breaker, bulkhead }]) => ({
      dependency,
      state: breaker.opened ? "open" : breaker.halfOpen ? "half-open" : "closed",
      successes: breaker.stats.successes,
      failures: breaker.stats.failures,
      rejects: breaker.stats.rejects,
      bulkhead: bulkhead.stats(),
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
    for (const { breaker } of this.dependencies.values()) breaker.shutdown();
    // The bulkheads need nothing: they own no timer of their own beyond a
    // queued caller's wait, and every one of those is already guaranteed to
    // settle by `maxQueueWaitMs`. Dropping the map cannot strand a waiter.
    this.dependencies.clear();
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

  private dependencyFor(dependency: string): Dependency {
    const existing = this.dependencies.get(dependency);
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

    const entry: Dependency = {
      breaker: created,
      bulkhead: new Bulkhead(dependency, this.options.bulkhead),
    };
    this.dependencies.set(dependency, entry);
    return entry;
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
