/**
 * Which implementation backs `WorkerPool`.
 *
 * `piscina` runs tasks on a fixed-size `worker_threads` pool with a bounded
 * queue; `inline` runs them on the caller's thread inside a resolved promise —
 * useful in tests, and honest about what it does (it does *not* isolate,
 * timeout, or bound anything).
 *
 * Declared here rather than in `config/env.schema.ts` so the module owns its
 * own vocabulary, matching the arrangement `DISTRIBUTED_LOCK_NAMES`,
 * `IDEMPOTENCY_STORE_NAMES` and `STORAGE_ADAPTER_NAMES` use.
 */
export const WORKER_POOL_NAMES = ["piscina", "inline"] as const;

export type WorkerPoolName = (typeof WORKER_POOL_NAMES)[number];

/** Injection token for the selected {@link WorkerPool}. */
export const WORKER_POOL = Symbol("WORKER_POOL");

/**
 * The one place the pool's task catalogue is declared.
 *
 * Tasks are keyed by string so a Piscina worker file can dispatch on the name
 * without pulling in the caller's closure — that closure does not survive
 * `postMessage`. The input and output shapes are the compile-time part: a
 * caller of `run("csv.encode", …)` gets its input checked against
 * `CsvEncodeInput` and its result narrowed to `CsvEncodeOutput`, and a new
 * task added to the map without a corresponding worker branch is a
 * compile-time hole rather than a runtime `unknown task` later on.
 *
 * Payloads must be structured-cloneable — no functions, no classes with
 * behaviour, no `Buffer` methods. `Buffer` is transferred as `Uint8Array` and
 * has to be handled that way on the far side.
 */
export interface WorkerTaskMap {
  // Populated by the tasks barrel; declaration-merged there so a new task can
  // be added by writing one file rather than editing this contract.
  readonly _brand: "WorkerTaskMap";
}

export type WorkerTaskName = Exclude<keyof WorkerTaskMap, "_brand">;

export type WorkerTaskInput<Name extends WorkerTaskName> = WorkerTaskMap[Name] extends {
  input: infer I;
}
  ? I
  : never;

export type WorkerTaskOutput<Name extends WorkerTaskName> = WorkerTaskMap[Name] extends {
  output: infer O;
}
  ? O
  : never;

export interface WorkerRunOptions {
  /**
   * Aborts the task. A queued task is dropped from the queue; a running task
   * is not — the pool cannot forcibly terminate a worker without discarding
   * the thread, so a signal that fires after work has started tears down the
   * promise but the CPU keeps burning until the task returns of its own
   * accord. Long-running tasks are expected to observe the signal themselves;
   * the two demo tasks in this repo do not, because their expected runtime is
   * a few tens of milliseconds and adding an observation would only make them
   * slower.
   */
  readonly signal?: AbortSignal;
  /**
   * Bound on how long the pool waits for a result before rejecting with
   * `WorkerPoolTimeoutError`. Overrides `WORKER_POOL_TASK_TIMEOUT_MS` for
   * this call. See the note on `signal` above: the underlying work is not
   * cancelled, only the wait for it.
   */
  readonly timeoutMs?: number;
}

/**
 * A fixed-size pool that runs CPU-bound work off the event loop.
 *
 * The reason the interface is so small is that the interesting decisions live
 * on the pool: size, queue depth, task timeout. The caller only chooses which
 * task to run and passes an argument matching its declared shape. Everything
 * else — thread affinity, `MessagePort` marshalling, worker recycling — is
 * the adapter's problem, and the adapter is chosen at boot.
 *
 * A pool is a scarce, process-scoped resource: two `WorkerPool`s means two
 * thread pools, which defeats the point of having one. `WorkersModule`
 * provides exactly one under {@link WORKER_POOL} and every caller injects it.
 */
export interface WorkerPool {
  /**
   * Runs a task on a worker thread.
   *
   * Resolves with the task's output. Rejects with a `WorkerPoolSaturatedError`
   * when the queue is full (the whole point of a bounded queue — the caller
   * gets a fast failure it can turn into a 503 rather than waiting behind an
   * unbounded backlog), with a `WorkerPoolTimeoutError` on `timeoutMs`
   * expiry, with a `WorkerPoolAbortedError` on `signal` fire, or with the
   * task's own error (rethrown across the wire with `name` and `message`
   * preserved) if it threw.
   */
  run<Name extends WorkerTaskName>(
    task: Name,
    input: WorkerTaskInput<Name>,
    options?: WorkerRunOptions,
  ): Promise<WorkerTaskOutput<Name>>;

  /**
   * Live pool statistics — what the pool would report to `/health` or a
   * dashboard. Meant for reading, never for adjusting: the pool's own
   * invariants (queue is bounded, threads are fixed) are not respected if a
   * caller writes to it.
   */
  stats(): WorkerPoolStats;

  /**
   * Drains queued work and terminates the workers. Idempotent; a second
   * `shutdown()` awaits the first. The pool refuses new work once shutdown
   * has been requested and rejects it with `WorkerPoolClosedError` — the same
   * status the caller gets after `NestApplication.close()` has run.
   */
  shutdown(): Promise<void>;
}

/**
 * A snapshot of what the pool is currently doing. All counts are per-process:
 * a second replica has its own pool and its own stats.
 */
export interface WorkerPoolStats {
  /** Configured hard cap on concurrent workers. */
  readonly maxThreads: number;
  /** Configured hard cap on queued (not yet running) tasks. */
  readonly maxQueue: number;
  /** Tasks running right now. Bounded above by `maxThreads`. */
  readonly running: number;
  /** Tasks waiting for a worker. Bounded above by `maxQueue`. */
  readonly queued: number;
  /** Tasks that have completed successfully since the pool started. */
  readonly completed: number;
  /**
   * `queued / maxQueue`, rounded to two decimals. `1.0` means the next `run`
   * will reject with `WorkerPoolSaturatedError`; a value climbing over
   * successive samples is the signal `WORKER_POOL_MAX_QUEUE` needs raising
   * or the offending caller has to shed load.
   */
  readonly saturation: number;
}
