/**
 * The one dispatch table the worker file reads.
 *
 * Every task registers its own handler here so a new task can be added by
 * writing one file (the `.task.ts`) plus one entry below — the same place
 * the compile-time `WorkerTaskMap` gets augmented from. Keeping the two in
 * lock-step is how the pool's compile-time typing stays honest at run time.
 */
import { encodeCsv } from "./csv-encode.task";
import { sha256Hex } from "./sha256-hex.task";
import { sleepTask } from "./sleep.task";
import type {
  WorkerTaskMap,
  WorkerTaskName,
  WorkerTaskInput,
  WorkerTaskOutput,
} from "../ports/worker-pool.port";

export * from "./csv-encode.task";
export * from "./sha256-hex.task";
export * from "./sleep.task";

export type WorkerTaskHandler<Name extends WorkerTaskName> = (
  input: WorkerTaskInput<Name>,
) => WorkerTaskOutput<Name> | Promise<WorkerTaskOutput<Name>>;

export type WorkerTaskHandlers = {
  readonly [Name in WorkerTaskName]: WorkerTaskHandler<Name>;
};

/**
 * The registry. Read by the Piscina worker file and by the inline pool. A
 * task added to {@link WorkerTaskMap} without an entry here is a compile
 * error (`WorkerTaskHandlers` requires every name); an entry here without a
 * `WorkerTaskMap` augmentation is a compile error too (the key has no known
 * name to bind to). The two failure modes leave nowhere to silently drop a
 * task.
 */
export const WORKER_TASK_HANDLERS = {
  "csv.encode": encodeCsv,
  "sha256.hex": sha256Hex,
  "test.sleep": sleepTask,
} as const satisfies WorkerTaskHandlers;

/**
 * All registered names, at runtime. `Object.keys` narrowed to the map's own
 * key set, which is what the worker file uses to reject unknown tasks with a
 * useful message rather than an `undefined is not a function`.
 */
export const WORKER_TASK_NAMES = Object.keys(WORKER_TASK_HANDLERS) as readonly WorkerTaskName[];

// Ensure the compiler sees the augmentations. Without an import of these
// modules the ambient `declare module` blocks that populate `WorkerTaskMap`
// would only be applied where they were imported directly.
export type { WorkerTaskMap };
