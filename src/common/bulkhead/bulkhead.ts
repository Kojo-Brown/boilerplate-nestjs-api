/**
 * A counting semaphore with a bounded FIFO wait queue: the bulkhead pattern,
 * as a primitive with no transport in it.
 *
 * It lives in `common/` next to `common/backoff` and for the same reason — the
 * first caller is `ResilientHttpClient`, which puts one in front of each
 * outbound dependency, but nothing here knows what a request is. A bulkhead is
 * a cap on how much of a shared resource one dependency may hold at once, and
 * the resource this process is actually short of is not sockets: it is the
 * event loop, the memory of everything parked on an unresolved promise, and the
 * inbound requests that are still waiting behind them.
 *
 * The failure it exists for is the dependency that is *slow* rather than
 * broken. A circuit breaker reads history, so it can only react once enough
 * calls have finished failing; a dependency answering in nine seconds, just
 * inside its ten-second timeout, never produces that history. Every caller that
 * arrives inside those nine seconds is admitted, and with enough arrivals the
 * whole process is holding requests open against one integration while
 * everything else in the service queues behind it. Capping concurrency is what
 * turns that from an outage into slow calls to one dependency.
 */

/** The knobs a bulkhead is built from. */
export interface BulkheadPolicy {
  /** Calls allowed to be in flight at once. */
  readonly maxConcurrent: number;
  /**
   * Callers allowed to wait for a permit. Reaching it rejects immediately,
   * which is the whole point: an unbounded queue converts a concurrency
   * problem into a memory problem and hides it until the process dies.
   */
  readonly maxQueued: number;
  /**
   * How long a caller waits for a permit before being rejected.
   *
   * Small on purpose. A queue is worth having for the burst that clears in a
   * moment; parking a caller for as long as the request itself may take turns
   * the queue into a second timeout everybody pays.
   */
  readonly maxQueueWaitMs: number;
}

/**
 * Why a call was turned away.
 *
 * Both are back-pressure rather than failure — nothing was sent — but they say
 * different things about the load. `queue-full` is more work arriving than the
 * cap and the queue together can hold; `queue-timeout` is a queue that is
 * draining too slowly to be worth waiting in.
 */
export type BulkheadRejectionReason = "queue-full" | "queue-timeout";

/**
 * A call the bulkhead refused to admit.
 *
 * A plain `Error`, not an `HttpException`: this primitive has no opinion about
 * status codes, and the one caller that does — `ResilientHttpClient` —
 * translates it, the same way it translates opossum's `EOPENBREAKER`.
 */
export class BulkheadRejectedError extends Error {
  constructor(
    /** The bulkhead's name — the dependency, for the HTTP client's bulkheads. */
    readonly bulkhead: string,
    readonly reason: BulkheadRejectionReason,
    readonly policy: BulkheadPolicy,
    /** How long this caller actually spent queued before being rejected. */
    readonly waitedMs: number,
  ) {
    super(
      reason === "queue-full"
        ? `Bulkhead "${bulkhead}" is full: ${policy.maxConcurrent} calls in flight and ` +
            `${policy.maxQueued} waiting, so this one was not admitted.`
        : `Bulkhead "${bulkhead}" did not admit a call within ${waitedMs}ms: ` +
            `${policy.maxConcurrent} calls are in flight and the queue is draining slower ` +
            `than the caller can wait.`,
    );
    this.name = "BulkheadRejectedError";
  }
}

/** What `stats()` reports, for a health indicator or a metrics scrape. */
export interface BulkheadStats {
  readonly name: string;
  /** Permits currently held. */
  readonly inFlight: number;
  /** Callers currently waiting for one. */
  readonly queued: number;
  readonly maxConcurrent: number;
  readonly maxQueued: number;
  /** Calls rejected since start because the queue was full. */
  readonly queueFullRejections: number;
  /** Calls rejected since start because they waited too long. */
  readonly queueTimeoutRejections: number;
}

/**
 * Releases a permit. Idempotent — calling it twice is a no-op rather than a
 * permit the bulkhead invents out of nothing.
 */
export type BulkheadPermit = () => void;

interface Waiter {
  readonly resolve: (permit: BulkheadPermit) => void;
  readonly reject: (error: Error) => void;
  readonly queuedAt: number;
  timer: NodeJS.Timeout | undefined;
}

export class Bulkhead {
  private inFlight = 0;
  private readonly waiting: Waiter[] = [];
  private queueFullRejections = 0;
  private queueTimeoutRejections = 0;

  constructor(
    readonly name: string,
    private readonly policy: BulkheadPolicy,
  ) {
    // A zero cap is not a very small bulkhead, it is one that admits nothing
    // and rejects every call for the life of the process. `envSchema` refuses
    // it at boot; this is the same check for a bulkhead built in code.
    if (!Number.isInteger(policy.maxConcurrent) || policy.maxConcurrent < 1) {
      throw new RangeError(
        `Bulkhead "${name}" needs maxConcurrent of at least 1, got ${policy.maxConcurrent}.`,
      );
    }
    if (!Number.isInteger(policy.maxQueued) || policy.maxQueued < 0) {
      throw new RangeError(
        `Bulkhead "${name}" needs maxQueued of at least 0, got ${policy.maxQueued}.`,
      );
    }
  }

  /**
   * Waits for a permit and returns the function that gives it back.
   *
   * `waitBudgetMs` shortens the wait for a caller that has a deadline of its
   * own — {@link ResilientHttpClient} passes whatever is left of the request's
   * total budget, so a call that has no time to spare is rejected instead of
   * queueing for time it does not have. It can only shorten the wait:
   * `maxQueueWaitMs` is the ceiling.
   *
   * Throws {@link BulkheadRejectedError} rather than resolving to a sentinel,
   * because "not admitted" is not an outcome a caller should be able to ignore
   * by forgetting to check.
   */
  acquire(waitBudgetMs: number = this.policy.maxQueueWaitMs): Promise<BulkheadPermit> {
    if (this.inFlight < this.policy.maxConcurrent) {
      this.inFlight += 1;
      return Promise.resolve(this.permit());
    }

    const budgetMs = Math.max(0, Math.min(Math.trunc(waitBudgetMs), this.policy.maxQueueWaitMs));

    // No budget and no free permit: queueing would be a wait this caller has
    // already said it cannot afford. Counted as a timeout because that is what
    // it is — a wait of zero that elapsed.
    if (budgetMs === 0) {
      this.queueTimeoutRejections += 1;
      return Promise.reject(new BulkheadRejectedError(this.name, "queue-timeout", this.policy, 0));
    }

    if (this.waiting.length >= this.policy.maxQueued) {
      this.queueFullRejections += 1;
      return Promise.reject(new BulkheadRejectedError(this.name, "queue-full", this.policy, 0));
    }

    return new Promise<BulkheadPermit>((resolve, reject) => {
      const waiter: Waiter = { resolve, reject, queuedAt: Date.now(), timer: undefined };
      waiter.timer = setTimeout(() => {
        const index = this.waiting.indexOf(waiter);
        // `release()` clears this timer before it hands a permit over, so a
        // timer that fires means the waiter is still queued. Checking is what
        // makes that safe rather than a `splice(-1, 1)` that would drop
        // somebody else's waiter.
        if (index < 0) return;
        this.waiting.splice(index, 1);
        this.queueTimeoutRejections += 1;
        reject(
          new BulkheadRejectedError(
            this.name,
            "queue-timeout",
            this.policy,
            Date.now() - waiter.queuedAt,
          ),
        );
      }, budgetMs);
      this.waiting.push(waiter);
    });
  }

  /** Runs `work` while holding a permit, releasing it however `work` ends. */
  async run<T>(work: () => Promise<T>, waitBudgetMs?: number): Promise<T> {
    const release = await this.acquire(waitBudgetMs);
    try {
      return await work();
    } finally {
      release();
    }
  }

  stats(): BulkheadStats {
    return {
      name: this.name,
      inFlight: this.inFlight,
      queued: this.waiting.length,
      maxConcurrent: this.policy.maxConcurrent,
      maxQueued: this.policy.maxQueued,
      queueFullRejections: this.queueFullRejections,
      queueTimeoutRejections: this.queueTimeoutRejections,
    };
  }

  private permit(): BulkheadPermit {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.release();
    };
  }

  private release(): void {
    const waiter = this.waiting.shift();
    if (waiter === undefined) {
      this.inFlight -= 1;
      return;
    }

    if (waiter.timer !== undefined) clearTimeout(waiter.timer);
    // The permit is handed straight over rather than released and re-taken, so
    // `inFlight` never dips below the cap for a tick. If it did, a caller
    // arriving in that tick would find a free permit and overshoot the cap
    // while a waiter that has been queued longer was still being resolved.
    waiter.resolve(this.permit());
  }
}
