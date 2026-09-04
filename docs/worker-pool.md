# Worker pool

CPU-bound work does not belong on the event loop. Every request that lands on
the process shares one, and a single 200 ms JSON-hash or 500 ms CSV encode
stalls every other request the process is serving for as long as it runs. The
worker pool moves that work to a fixed set of `worker_threads`, so the request
that triggered it waits, but nothing else does.

## What the pool is

`WORKER_POOL` (`src/workers/ports/worker-pool.port.ts`) is a port with two
adapters:

- `PiscinaWorkerPool` — the real one, backed by
  [piscina](https://github.com/piscinajs/piscina). A fixed thread pool with a
  bounded queue and per-call `AbortSignal` support. This is what production
  runs.
- `InlineWorkerPool` — a stand-in for tests and small deployments. It runs
  each task on the caller's thread inside a resolved promise while preserving
  the pool's observable contract — bounded queue, `stats()`, `shutdown()`,
  the four typed error classes — so a test written against the port passes
  against both. It does **not** offload work; it does **not** isolate.

Every registered task is described in one place:
`src/workers/ports/worker-pool.port.ts` declares an empty `WorkerTaskMap`,
and each `*.task.ts` file augments the map with its input and output shape.
`src/workers/tasks/index.ts` collects the handlers into `WORKER_TASK_HANDLERS`,
and the worker file (`src/workers/worker.ts`) dispatches on the incoming
`{ task, input }` envelope. A new task is added by writing one file:

```ts
// src/workers/tasks/my-task.task.ts
export interface MyTaskInput { … }
export interface MyTaskOutput { … }
export function myTask(input: MyTaskInput): MyTaskOutput { … }

declare module "../ports/worker-pool.port" {
  interface WorkerTaskMap {
    readonly "my.task": { input: MyTaskInput; output: MyTaskOutput };
  }
}
```

Then add one entry to `WORKER_TASK_HANDLERS` in `tasks/index.ts`. The two
sides are kept in lock-step at compile time: a new `WorkerTaskMap` entry
without a matching handler is a type error, and a handler without a map entry
does not compile either.

## What the pool is not

Piscina cannot cancel a running task. `AbortSignal` and `timeoutMs` tear
down the caller's wait for the result; the worker keeps burning CPU until
the task returns of its own accord. A long-running task that wants to
observe cancellation has to check `parentPort` messages itself — neither
demo task does, because their expected runtimes are a few tens of
milliseconds and adding an observation only makes them slower.

Payloads cross `postMessage`. They must be structured-cloneable — no
functions, no classes with behaviour, no `Buffer` methods on the far side.
`Buffer` is transferred as a `Uint8Array` and has to be treated as one.

## Bounded queue and backpressure

`WORKER_POOL_MAX_QUEUE` (default 32) is a hard cap on queued tasks. Once
the queue fills, `pool.run()` rejects with `WorkerPoolSaturatedError`
synchronously — no CPU is spent on the task at all. The typical response is
a 503:

```ts
try {
  const out = await this.pool.run("csv.encode", { columns, rows });
  return out.bytes;
} catch (err) {
  if (err instanceof WorkerPoolSaturatedError) {
    throw new HttpException("Server is busy, try again", HttpStatus.SERVICE_UNAVAILABLE);
  }
  throw err;
}
```

Piscina's own default is `Infinity`, which turns the pool into a memory leak
the moment producers outrun workers. The bounded queue is the whole point.

## Cancellation and timeouts

`run()` accepts an `AbortSignal` and an optional `timeoutMs`. Both surface
through the pool's own typed errors (`WorkerPoolAbortedError`,
`WorkerPoolTimeoutError`), which is what the contract tests pin. See "What
the pool is not" above for the important caveat: the wait ends; the CPU
keeps burning.

The default per-call timeout is `WORKER_POOL_TASK_TIMEOUT_MS`
(default 30 s). Every task takes that as a ceiling unless the caller passes
one of its own.

## Configuration

| Variable                      | Default  | Notes                                                                                                                  |
| ----------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------- |
| `WORKER_POOL`                 | `inline` | `piscina` in production, `inline` for tests                                                                            |
| `WORKER_POOL_MAX_THREADS`     | `2`      | Piscina's default is `availableParallelism() - 1`, which is invisible to a container's cgroup — pick a number you mean |
| `WORKER_POOL_MAX_QUEUE`       | `32`     | Hard cap; over it, `run()` rejects fast                                                                                |
| `WORKER_POOL_TASK_TIMEOUT_MS` | `30000`  | Per-call ceiling; overridable per call                                                                                 |

`WORKER_POOL=inline` in production is permitted but knowingly degrades
performance under load: the CPU-bound work runs on the event loop and blocks
every other request that landed on the same process. Pick it deliberately.

## Not done

- No production call site injects `WORKER_POOL` yet. The two registered
  tasks — `csv.encode` and `sha256.hex` — are the demo surface, exercised
  by the contract tests but not yet wired into a controller. The natural
  next call site is a `GET /v1/users/export.csv` admin endpoint that
  paginates through `ListUsersQuery` and hands each page to
  `csv.encode`.
- No per-task metric hook. The pool reports `stats()`, which is enough for a
  `/health` gauge; a Prometheus histogram of per-task duration belongs to
  Phase 11.
