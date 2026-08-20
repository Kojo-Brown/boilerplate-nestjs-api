/**
 * Every failure mode of {@link WorkerPool.run} that is *the pool's* rather
 * than the task's. A task's own thrown error is rethrown across the wire and
 * subclasses none of these; a `HttpException` from the task is still a
 * `HttpException` when the caller catches it. See `worker.ts` for the
 * serialisation contract.
 */
export abstract class WorkerPoolError extends Error {}

/**
 * The queue is full. This is what `WORKER_POOL_MAX_QUEUE` exists to
 * produce: a fast rejection the caller can turn into a 503 rather than
 * unbounded latency behind a growing backlog. Not retryable inside the
 * request that got it — the queue is already too long for another entry.
 */
export class WorkerPoolSaturatedError extends WorkerPoolError {
  override readonly name = "WorkerPoolSaturatedError";
  constructor(
    readonly task: string,
    readonly queued: number,
    readonly maxQueue: number,
  ) {
    super(
      `worker pool queue is full running task "${task}" ` +
        `(queued=${queued}/${maxQueue}); shed load or raise WORKER_POOL_MAX_QUEUE`,
    );
  }
}

/**
 * The task took longer than the caller (or the pool default) was willing to
 * wait for. See `WorkerRunOptions.signal` for what this *does not* do: the
 * worker keeps burning CPU until the task returns, because Piscina cannot
 * cancel one without discarding the whole thread and restarting it.
 */
export class WorkerPoolTimeoutError extends WorkerPoolError {
  override readonly name = "WorkerPoolTimeoutError";
  constructor(
    readonly task: string,
    readonly timeoutMs: number,
  ) {
    super(`worker task "${task}" did not complete within ${timeoutMs}ms`);
  }
}

/**
 * The caller's `AbortSignal` fired. If the task was still queued, it is gone
 * from the queue and no CPU was spent on it; if it was running, the wait for
 * the result is rejected but the CPU keeps burning until the task returns.
 */
export class WorkerPoolAbortedError extends WorkerPoolError {
  override readonly name = "WorkerPoolAbortedError";
  constructor(readonly task: string) {
    super(`worker task "${task}" was aborted by the caller`);
  }
}

/**
 * The pool has been shut down. `shutdown()` refuses new work as soon as it
 * has been requested; the caller's `run` throws this instead of getting stuck
 * behind a drain that has no plan to accept it.
 */
export class WorkerPoolClosedError extends WorkerPoolError {
  override readonly name = "WorkerPoolClosedError";
  constructor(readonly task: string) {
    super(`worker pool is shutting down; task "${task}" refused`);
  }
}

/**
 * The worker file reported an unknown task name. This is a programmer error —
 * `WorkerTaskMap` and the worker's dispatch table are out of step — and the
 * pool surfaces it verbatim rather than swallowing it.
 */
export class UnknownWorkerTaskError extends WorkerPoolError {
  override readonly name = "UnknownWorkerTaskError";
  constructor(readonly task: string) {
    super(`no worker handler is registered for task "${task}"`);
  }
}

/**
 * Convenience: is this failure the pool's rather than the task's?
 */
export function isWorkerPoolError(err: unknown): err is WorkerPoolError {
  return err instanceof WorkerPoolError;
}
