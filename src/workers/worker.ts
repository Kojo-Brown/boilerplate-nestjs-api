/**
 * The file Piscina spawns as a worker.
 *
 * Piscina calls the module's default export with each task's payload. That
 * payload arrives as a `{ task, input }` envelope so one worker file can host
 * every registered task rather than needing one file per task — the alternative
 * costs a thread pool per task, which is exactly the fragmentation the whole
 * feature exists to avoid.
 *
 * The envelope shape is repeated (rather than imported from the port) because
 * this file runs inside a worker with its own module graph: the fewer things
 * it imports from the caller side, the smaller the worker's startup cost.
 * Handlers themselves are pure functions, so the shared `tasks/` directory is
 * safe to reach into.
 */

import { WORKER_TASK_HANDLERS, WORKER_TASK_NAMES } from "./tasks";
import type { WorkerTaskName, WorkerTaskInput, WorkerTaskOutput } from "./ports/worker-pool.port";

export interface WorkerEnvelope<Name extends WorkerTaskName = WorkerTaskName> {
  readonly task: Name;
  readonly input: WorkerTaskInput<Name>;
}

/**
 * The dispatcher. Piscina awaits whatever this returns and rejects the
 * caller's promise with whatever this throws — an unknown task name is one of
 * those, and the message matches `UnknownWorkerTaskError` so the pool can
 * rethrow it as one rather than a bare `Error`.
 */
export default async function handle<Name extends WorkerTaskName>(
  envelope: WorkerEnvelope<Name>,
): Promise<WorkerTaskOutput<Name>> {
  // Same erased narrowing as `InlineWorkerPool.execute`: `handler` is the
  // right shape at the surface but TypeScript refuses to walk the indexed
  // access into a union of narrowed callables.
  const handler = WORKER_TASK_HANDLERS[envelope.task] as unknown as (
    input: WorkerTaskInput<Name>,
  ) => WorkerTaskOutput<Name> | Promise<WorkerTaskOutput<Name>>;
  if (typeof handler !== "function") {
    // `UnknownWorkerTaskError` cannot be imported here without dragging the
    // main-thread error classes into every worker; the pool recognises the
    // `name` on the deserialised error and reconstructs the typed one.
    const err = new Error(
      `no worker handler is registered for task "${String(envelope.task)}" ` +
        `(known: ${WORKER_TASK_NAMES.join(", ")})`,
    );
    err.name = "UnknownWorkerTaskError";
    throw err;
  }
  return handler(envelope.input);
}
