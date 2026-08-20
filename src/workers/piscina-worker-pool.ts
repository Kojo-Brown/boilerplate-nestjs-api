import { Injectable, Logger } from "@nestjs/common";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Piscina from "piscina";
import type {
  WorkerPool,
  WorkerPoolStats,
  WorkerRunOptions,
  WorkerTaskInput,
  WorkerTaskName,
  WorkerTaskOutput,
} from "./ports/worker-pool.port";
import {
  UnknownWorkerTaskError,
  WorkerPoolAbortedError,
  WorkerPoolClosedError,
  WorkerPoolSaturatedError,
} from "./worker-pool.errors";
import { raceWithSignals } from "./inline-worker-pool";

/**
 * Real Piscina-backed pool.
 *
 * The interesting decisions are all in the constructor's `Piscina` options:
 *
 * - `maxThreads` is a hard cap on concurrent workers. Piscina defaults to
 *   `os.availableParallelism() - 1`; the pool refuses to trust that default
 *   because a container's cgroup CPU quota is invisible to it, and the
 *   `WORKER_POOL_MAX_THREADS` env var is the operator's one lever.
 *
 * - `maxQueue` is a hard cap on the queue. Piscina defaults to `Infinity`,
 *   which turns the pool into a memory leak the moment producers outrun
 *   workers. The pool rejects overflow with `WorkerPoolSaturatedError` before
 *   calling `piscina.run` — Piscina's own overflow behaviour returns a
 *   rejected promise whose message is opaque, and callers want the pool's
 *   own error class so they can map it to 503.
 *
 * - `concurrentTasksPerWorker` stays at 1 (Piscina's default) because a
 *   worker running two `sha256.hex` calls at once burns one CPU core between
 *   them and only makes each half as fast — the whole point of the pool is
 *   one task per thread.
 *
 * - `filename` is resolved from `__dirname`, which lands under `dist/workers`
 *   after `nest build` and under `src/workers` under ts-node. Both cases
 *   check the file exists at construction time rather than at first `run`,
 *   because a missing worker file is a deployment error and a caller waiting
 *   on a request deserves the same startup failure the operator got.
 */
@Injectable()
export class PiscinaWorkerPool implements WorkerPool {
  private readonly logger = new Logger(PiscinaWorkerPool.name);
  private readonly piscina: Piscina;
  private closed = false;
  private drain?: Promise<void>;
  /**
   * Total accepted tasks that have not yet resolved. Tracked here rather
   * than read off `piscina.queueSize + threads.length - idleThreads` because
   * Piscina updates those asynchronously (workers spawn after `run` returns,
   * and `idleThreads` moves when the worker actually picks up a message);
   * a caller submitting three tasks in one tick reads the same live count
   * as anyone submitting them synchronously through this adapter.
   */
  private outstanding = 0;

  constructor(
    private readonly options: {
      readonly maxThreads: number;
      readonly maxQueue: number;
      readonly minThreads?: number;
      readonly idleTimeoutMs?: number;
      readonly taskTimeoutMs: number;
      /**
       * Absolute path to the compiled worker file. Defaults to
       * `<__dirname>/worker.js`; the constructor also probes for `worker.ts`
       * so ts-node-driven test runs can spin up a real worker without a
       * build step. A caller that passes a value takes the blame for it.
       */
      readonly workerFilename?: string;
      /**
       * `execArgv` for the spawned worker process. Defaults to the parent's
       * `process.execArgv`; the constructor adds `-r ts-node/register` when
       * pointing at a `.ts` file so the worker can load it, and refuses to
       * add it silently in production.
       */
      readonly execArgv?: readonly string[];
    },
  ) {
    const filename = options.workerFilename ?? resolveWorkerFilename();
    if (!existsSync(filename)) {
      throw new Error(
        `piscina worker file not found at ${filename} — a nest build should place ` +
          "worker.js beside this module; check that dist/workers is being built and shipped",
      );
    }

    const isTs = filename.endsWith(".ts");
    const execArgv = options.execArgv ? [...options.execArgv] : [...process.execArgv];
    if (isTs && !execArgv.some((a) => a.includes("ts-node/register"))) {
      if (process.env.NODE_ENV === "production") {
        throw new Error(
          `piscina refuses to load ${filename}: worker filenames must be compiled ` +
            "JavaScript in production, not TypeScript source",
        );
      }
      execArgv.push("-r", "ts-node/register");
    }

    // `options.maxQueue` on the port is the total outstanding tasks the pool
    // accepts (queued + running). Piscina's own `maxQueue` counts only the
    // waiting portion, so the internal cap is `port.maxQueue - maxThreads`,
    // floored at 0. Doing it this way makes both adapters' saturation error
    // fire on the same submission count — the property the contract test
    // asserts.
    const piscinaMaxQueue = Math.max(0, options.maxQueue - options.maxThreads);
    this.piscina = new Piscina({
      filename,
      maxThreads: options.maxThreads,
      minThreads: options.minThreads ?? Math.min(1, options.maxThreads),
      maxQueue: piscinaMaxQueue,
      idleTimeout: options.idleTimeoutMs ?? 30_000,
      concurrentTasksPerWorker: 1,
      execArgv,
    });

    // Piscina emits an `error` event when a worker dies unexpectedly. Log it
    // rather than let the default `EventEmitter` unhandled-error hoist crash
    // the process — a task that killed its worker rejects the caller's
    // promise on its own, and losing the worker is already accounted for by
    // Piscina's recycling.
    this.piscina.on("error", (err: unknown) => {
      this.logger.error(
        `piscina worker crashed: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
  }

  async run<Name extends WorkerTaskName>(
    task: Name,
    input: WorkerTaskInput<Name>,
    runOptions?: WorkerRunOptions,
  ): Promise<WorkerTaskOutput<Name>> {
    if (this.closed) throw new WorkerPoolClosedError(task);
    if (runOptions?.signal?.aborted) throw new WorkerPoolAbortedError(task);

    // Fast pre-check on total outstanding (queued + running). The typed
    // error is thrown synchronously so a caller can map it to a 503 without
    // waiting for Piscina's own overflow rejection to work its way back.
    // `translateError` below is the belt to this braces: if Piscina rejects
    // internally (a misconfigured internal maxQueue, or a caller squeezing
    // through the pre-check race) the same typed error is surfaced from
    // the tail path too.
    if (this.outstanding >= this.options.maxQueue) {
      throw new WorkerPoolSaturatedError(task, this.outstanding, this.options.maxQueue);
    }
    this.outstanding += 1;

    const timeoutMs = runOptions?.timeoutMs ?? this.options.taskTimeoutMs;

    const work = this.piscina
      .run({ task, input }, { signal: runOptions?.signal ?? null })
      .catch((err: unknown) => {
        throw translateError(task, err);
      })
      .finally(() => {
        this.outstanding -= 1;
      });
    return raceWithSignals(task, work as Promise<WorkerTaskOutput<Name>>, undefined, timeoutMs);
  }

  stats(): WorkerPoolStats {
    // `running` and `queued` come off Piscina — they are what Piscina
    // itself knows about worker occupancy. `outstanding` is what the
    // adapter enforces the cap against and can lead Piscina's own count by
    // one tick while a submitted task is still being handed to a worker.
    const running = Math.max(0, this.piscina.threads.length - this.piscina.idleThreads);
    const queued = this.piscina.queueSize;
    return {
      maxThreads: this.options.maxThreads,
      maxQueue: this.options.maxQueue,
      running,
      queued,
      completed: this.piscina.completed,
      saturation:
        this.options.maxQueue === 0
          ? 0
          : Math.round((this.outstanding / this.options.maxQueue) * 100) / 100,
    };
  }

  async shutdown(): Promise<void> {
    if (this.drain) return this.drain;
    this.closed = true;
    this.drain = this.piscina.close().then(() => {
      this.logger.log(`piscina pool drained (completed=${this.piscina.completed})`);
    });
    return this.drain;
  }
}

/**
 * Maps Piscina's opaque rejections to the pool's typed error classes.
 *
 * Piscina throws `Error` with `message === 'The task has been aborted'` for
 * an aborted task and `message === 'Terminating worker thread'` for a
 * pool-shutdown-during-run, neither of which is a class the caller can
 * `instanceof`. Rethrown as the typed one, so `catch (err) { if (err
 * instanceof WorkerPoolAbortedError) ... }` works the same way both
 * adapters.
 */
function translateError(task: string, err: unknown): Error {
  if (!(err instanceof Error)) return new Error(String(err));
  const msg = err.message;

  if (msg.includes("aborted") || err.name === "AbortError") {
    return new WorkerPoolAbortedError(task);
  }
  if (msg.includes("queue is at limit") || msg.includes("Task queue is at limit")) {
    return new WorkerPoolSaturatedError(task, -1, -1);
  }
  if (msg.includes("Terminating worker thread") || msg.includes("closed")) {
    return new WorkerPoolClosedError(task);
  }
  if (err.name === "UnknownWorkerTaskError") {
    return new UnknownWorkerTaskError(task);
  }
  return err;
}

function resolveWorkerFilename(): string {
  const here = resolveHere();
  const jsPath = join(here, "worker.js");
  if (existsSync(jsPath)) return jsPath;
  const tsPath = join(here, "worker.ts");
  if (existsSync(tsPath)) return tsPath;
  return jsPath; // return the .js path so the "not found" error names the expected one
}

function resolveHere(): string {
  // Handles both CJS (`__dirname` populated) and ESM (`import.meta.url`), so
  // the pool survives whichever module system NestJS ends up with.
  if (typeof __dirname !== "undefined" && __dirname) return __dirname;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const meta = (globalThis as any).import?.meta as ImportMeta | undefined;
  if (meta?.url) return dirname(fileURLToPath(meta.url));
  return process.cwd();
}
