import { describeWorkerPoolContract } from "./worker-pool.contract";
import { InlineWorkerPool } from "./inline-worker-pool";
import { PiscinaWorkerPool } from "./piscina-worker-pool";

/**
 * One contract, both backends.
 *
 * The Piscina leg spins up a real `worker_threads` pool via ts-node (the
 * worker is `worker.ts`; the same file that runs from `dist/workers/worker.js`
 * in production). A test machine that cannot spawn a worker thread — an
 * unusual environment, but not unheard of — reports that leg as pending
 * rather than a green skip.
 */

describeWorkerPoolContract(
  "InlineWorkerPool",
  async () => {
    const pool = new InlineWorkerPool({
      maxThreads: 1,
      maxQueue: 2,
      taskTimeoutMs: 30_000,
    });
    return { pool, slowMs: 40 };
  },
  async (h) => {
    await h.pool.shutdown();
  },
);

if (canSpawnWorker()) {
  describeWorkerPoolContract(
    "PiscinaWorkerPool",
    async () => {
      const pool = new PiscinaWorkerPool({
        maxThreads: 1,
        maxQueue: 2,
        taskTimeoutMs: 30_000,
      });
      return { pool, slowMs: 80 };
    },
    async (h) => {
      await h.pool.shutdown();
    },
  );
} else {
  describe("PiscinaWorkerPool (worker pool contract)", () => {
    it.todo("this environment cannot spawn worker_threads");
  });
}

function canSpawnWorker(): boolean {
  // node:worker_threads is always resolvable on the Node versions this repo
  // supports, so a synchronous check is enough to gate the leg. The one
  // environment that can hit `false` is a `--single-threaded` build, which
  // no supported runner uses.
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return typeof require("node:worker_threads").Worker === "function";
  } catch {
    return false;
  }
}
