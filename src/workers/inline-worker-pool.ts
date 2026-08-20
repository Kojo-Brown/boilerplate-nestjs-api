import { Injectable, Logger } from "@nestjs/common";
import type {
  WorkerPool,
  WorkerPoolStats,
  WorkerRunOptions,
  WorkerTaskInput,
  WorkerTaskName,
  WorkerTaskOutput,
} from "./ports/worker-pool.port";
import {
  WorkerPoolAbortedError,
  WorkerPoolClosedError,
  WorkerPoolSaturatedError,
  WorkerPoolTimeoutError,
} from "./worker-pool.errors";
import { WORKER_TASK_HANDLERS } from "./tasks";

/**
 * A `WorkerPool` that runs on the caller's thread.
 *
 * The name is a promise, not a threat: no isolation, no CPU offload, no
 * independent memory. What it *does* preserve is the pool's observable
 * contract — a bounded backlog, per-call aborts, per-call timeouts,
 * `stats()`, `shutdown()` — so every test written against the port passes
 * against both this and the Piscina one. `WORKER_POOL=inline` in production
 * is a knob, not a correctness bug (it costs latency, not safety), so unlike
 * the memory locking and idempotency stores the schema permits it in
 * production and the docs say why.
 *
 * Tasks serialise through a single-slot chain: `run` chains the next task
 * onto the previous one's tail, so at most one runs at a time. That models
 * a Piscina pool with `concurrentTasksPerWorker: 1` and `maxThreads: 1`,
 * which is what the contract tests configure, and it is what makes the
 * bounded backlog observable — a second submission has to wait for the
 * first.
 *
 * `maxQueue` on the port is the total outstanding tasks the pool will
 * accept (queued + running), not just the waiting portion. That is the
 * one number an operator can sensibly turn into a rate-limit dashboard,
 * and it is also what makes both adapters' `WorkerPoolSaturatedError` fire
 * on the same submission count in the contract test.
 */
@Injectable()
export class InlineWorkerPool implements WorkerPool {
  private readonly logger = new Logger(InlineWorkerPool.name);
  private tail: Promise<unknown> = Promise.resolve();
  private outstanding = 0;
  private running = 0;
  private completed = 0;
  private closed = false;
  private drain?: Promise<void>;

  constructor(
    private readonly options: {
      readonly maxQueue: number;
      readonly maxThreads: number;
      readonly taskTimeoutMs: number;
    },
  ) {}

  async run<Name extends WorkerTaskName>(
    task: Name,
    input: WorkerTaskInput<Name>,
    runOptions?: WorkerRunOptions,
  ): Promise<WorkerTaskOutput<Name>> {
    if (this.closed) throw new WorkerPoolClosedError(task);
    if (runOptions?.signal?.aborted) throw new WorkerPoolAbortedError(task);

    if (this.outstanding >= this.options.maxQueue) {
      throw new WorkerPoolSaturatedError(task, this.outstanding, this.options.maxQueue);
    }
    this.outstanding += 1;
    const timeoutMs = runOptions?.timeoutMs ?? this.options.taskTimeoutMs;
    const previous = this.tail;

    const next = previous.then(async () => {
      this.running += 1;
      try {
        // See `worker.ts` for the erasure this cast is honest about — the
        // dispatch is well-typed at the surface, but TypeScript will not
        // walk an indexed access into a narrowed callable.
        const handler = WORKER_TASK_HANDLERS[task] as unknown as (
          input: WorkerTaskInput<Name>,
        ) => WorkerTaskOutput<Name> | Promise<WorkerTaskOutput<Name>>;
        return await raceWithSignals(task, handler(input), runOptions?.signal, timeoutMs);
      } finally {
        this.running -= 1;
        this.outstanding -= 1;
        this.completed += 1;
      }
    });

    // The chain must not carry a rejection forward, or one failing task
    // would poison every subsequent one. Catch-and-drop is intentional; the
    // caller still sees the rejection through `next` itself.
    this.tail = next.catch(() => {});
    return next as Promise<WorkerTaskOutput<Name>>;
  }

  stats(): WorkerPoolStats {
    const queued = Math.max(0, this.outstanding - this.running);
    return {
      maxThreads: this.options.maxThreads,
      maxQueue: this.options.maxQueue,
      running: this.running,
      queued,
      completed: this.completed,
      saturation:
        this.options.maxQueue === 0 ? 0 : round2(this.outstanding / this.options.maxQueue),
    };
  }

  async shutdown(): Promise<void> {
    if (this.drain) return this.drain;
    this.closed = true;
    // Drain the whole chain: `tail` swallows rejections already, so awaiting
    // it is guaranteed to resolve once every queued task has run to
    // completion (or been rejected by its own abort/timeout).
    this.drain = this.tail.then(() => {
      this.logger.log(`inline worker pool drained (completed=${this.completed})`);
    });
    return this.drain;
  }
}

/**
 * Races a task's own promise against its `AbortSignal` and its timeout.
 *
 * Exported for the Piscina adapter, which runs the same waiting logic on
 * the main thread — the pool itself owns "how long to wait", not the
 * worker. See `worker-pool.errors.ts` for what "how long to wait" cannot
 * do: neither the signal nor the timeout stops the worker.
 */
export function raceWithSignals<T>(
  task: string,
  work: T | Promise<T>,
  signal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<T> {
  const workPromise = Promise.resolve(work);
  if (!signal && timeoutMs <= 0) return workPromise;

  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      fn();
    };

    const timer =
      timeoutMs > 0
        ? setTimeout(
            () => settle(() => reject(new WorkerPoolTimeoutError(task, timeoutMs))),
            timeoutMs,
          )
        : undefined;
    const onAbort = () => settle(() => reject(new WorkerPoolAbortedError(task)));
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onAbort);
    };
    if (signal) {
      if (signal.aborted) return settle(() => reject(new WorkerPoolAbortedError(task)));
      signal.addEventListener("abort", onAbort, { once: true });
    }

    workPromise
      .then((value) => settle(() => resolve(value)))
      .catch((err) => settle(() => reject(err)));
  });
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
