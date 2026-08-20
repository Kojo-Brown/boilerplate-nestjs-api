import type { WorkerPool } from "./ports/worker-pool.port";
import {
  WorkerPoolAbortedError,
  WorkerPoolClosedError,
  WorkerPoolSaturatedError,
  WorkerPoolTimeoutError,
} from "./worker-pool.errors";

/**
 * The behavioural contract every `WorkerPool` implementation must satisfy.
 *
 * `WORKER_POOL` picks the backend from the environment, so everything
 * downstream — the demo tasks, the `stats()` reader, callers that catch a
 * saturated pool and turn it into a 503 — behaves the same whichever leg CI
 * happens to be running (LSP). The `piscina` adapter defers to real
 * `worker_threads` for isolation and timing; the `inline` one runs on the
 * caller's thread. What the contract pins is *what a caller can observe*:
 *
 *   - a full backlog rejects `run` with `WorkerPoolSaturatedError` synchronously
 *   - an aborted `signal` rejects with `WorkerPoolAbortedError`
 *   - a run past its `timeoutMs` rejects with `WorkerPoolTimeoutError`
 *   - `stats()` reports queued and running under load
 *   - `shutdown()` is idempotent and refuses new work with `WorkerPoolClosedError`
 *
 * `test.sleep` is the task the timing-sensitive assertions use, because a CPU
 * task's runtime is a function of the host and a wall-clock wait is not.
 * A slow-encode assertion elsewhere in the suite still uses `csv.encode` —
 * this is the *pool*'s contract, not the task's.
 */
export interface WorkerPoolHarness {
  readonly pool: WorkerPool;
  /**
   * Milliseconds a `test.sleep` call the contract uses to model slow work.
   * Both adapters honour this — the inline pool via `setTimeout`, Piscina by
   * running the same code on a worker thread — so the same submission counts
   * produce the same saturation outcomes regardless of host CPU.
   */
  readonly slowMs: number;
}

export function describeWorkerPoolContract(
  name: string,
  createHarness: () => Promise<WorkerPoolHarness>,
  teardown: (harness: WorkerPoolHarness) => Promise<void>,
): void {
  describe(`${name} (worker pool contract)`, () => {
    let harness: WorkerPoolHarness;

    beforeEach(async () => {
      harness = await createHarness();
    });

    afterEach(async () => {
      await teardown(harness);
    });

    describe("run", () => {
      it("resolves with the task's output", async () => {
        const out = await harness.pool.run("sha256.hex", {
          bytes: new TextEncoder().encode("hello"),
        });
        expect(out.hex).toBe("2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824");
        expect(out.byteLength).toBe(5);
      });

      it("encodes a CSV round-trip", async () => {
        const out = await harness.pool.run("csv.encode", {
          columns: [
            { key: "id", header: "ID" },
            { key: "name", header: "Name" },
          ],
          rows: [
            { id: "u1", name: "Ada" },
            { id: "u2", name: 'B, "Grace"' },
          ],
        });
        const text = new TextDecoder().decode(out.bytes);
        expect(text).toBe('ID,Name\r\nu1,Ada\r\nu2,"B, ""Grace"""\r\n');
        expect(out.rowCount).toBe(2);
        expect(out.byteLength).toBe(out.bytes.byteLength);
      });

      it("rejects with WorkerPoolSaturatedError when the backlog is full", async () => {
        // `maxQueue` is 2 on both harnesses (total outstanding, matching the
        // port's semantics), so the third concurrent submission is refused.
        const first = harness.pool.run("test.sleep", { ms: harness.slowMs });
        const second = harness.pool.run("test.sleep", { ms: harness.slowMs });
        await expect(harness.pool.run("test.sleep", { ms: harness.slowMs })).rejects.toBeInstanceOf(
          WorkerPoolSaturatedError,
        );
        await Promise.all([first, second]);
      });

      it("rejects with WorkerPoolAbortedError when the signal aborts mid-flight", async () => {
        const controller = new AbortController();
        const inflight = harness.pool.run(
          "test.sleep",
          { ms: harness.slowMs * 4 },
          { signal: controller.signal },
        );
        setTimeout(() => controller.abort(), Math.max(1, Math.floor(harness.slowMs / 2)));
        await expect(inflight).rejects.toBeInstanceOf(WorkerPoolAbortedError);
      });

      it("rejects with WorkerPoolAbortedError when the signal is already aborted", async () => {
        const controller = new AbortController();
        controller.abort();
        await expect(
          harness.pool.run("test.sleep", { ms: harness.slowMs }, { signal: controller.signal }),
        ).rejects.toBeInstanceOf(WorkerPoolAbortedError);
      });

      it("rejects with WorkerPoolTimeoutError past the caller's timeout", async () => {
        await expect(
          harness.pool.run(
            "test.sleep",
            { ms: harness.slowMs * 8 },
            { timeoutMs: Math.max(2, Math.floor(harness.slowMs / 4)) },
          ),
        ).rejects.toBeInstanceOf(WorkerPoolTimeoutError);
      });
    });

    describe("stats", () => {
      it("reports the configured caps", () => {
        const stats = harness.pool.stats();
        expect(stats.maxThreads).toBeGreaterThan(0);
        expect(stats.maxQueue).toBeGreaterThan(0);
      });

      it("counts queued and running while tasks are in flight", async () => {
        const first = harness.pool.run("test.sleep", { ms: harness.slowMs * 2 });
        const second = harness.pool.run("test.sleep", { ms: harness.slowMs * 2 });
        // Both adapters need a tick to move the first task off the queue.
        await new Promise((r) => setTimeout(r, Math.max(1, Math.floor(harness.slowMs / 4))));
        const stats = harness.pool.stats();
        expect(stats.running + stats.queued).toBeGreaterThanOrEqual(1);
        expect(stats.saturation).toBeGreaterThan(0);
        await Promise.all([first, second]);
      });
    });

    describe("shutdown", () => {
      it("refuses new work after shutdown with WorkerPoolClosedError", async () => {
        await harness.pool.shutdown();
        await expect(
          harness.pool.run("sha256.hex", { bytes: new TextEncoder().encode("x") }),
        ).rejects.toBeInstanceOf(WorkerPoolClosedError);
      });

      it("is idempotent", async () => {
        await harness.pool.shutdown();
        await expect(harness.pool.shutdown()).resolves.toBeUndefined();
      });
    });
  });
}
