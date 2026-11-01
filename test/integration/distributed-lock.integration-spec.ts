import { Redis } from "ioredis";
import { RedisContainer } from "@testcontainers/redis";
import type { StartedRedisContainer } from "@testcontainers/redis";
import { describeDistributedLockContract } from "@/common/locking/distributed-lock.contract";
import { RedlockService } from "@/common/locking/redlock.service";
import { REDIS_TEST_DATABASES } from "@/test-utils/redis-test-databases";
import { REDIS_IMAGE, integrationRedisUrls } from "./containers";

const CONTRACT_DB = REDIS_TEST_DATABASES.distributedLockIntegration;
const TTL_MS = 10_000;

const SILENT = { debug: () => {}, warn: () => {} };

/**
 * A client that gives up instead of retrying forever.
 *
 * `retryStrategy: () => null` is what makes a *stopped* node testable. Without
 * it, ioredis keeps a reconnect timer alive for a server that is never coming
 * back, the test process will not exit, and Jest reports the worker as leaking
 * — which is precisely why `distributed-lock.contract.spec.ts` asserts its
 * node-down leg against `FakeRedisNode` rather than a real socket. With it, a
 * command to a dead node rejects at once, which is also what the algorithm
 * needs: a node that does not answer must be a missing vote, not a stall.
 */
function connect(url: string): Redis {
  return new Redis(url, {
    db: CONTRACT_DB,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    retryStrategy: () => null,
  }).on("error", () => {});
}

async function ready(node: Redis): Promise<void> {
  if (node.status === "ready") return;
  await new Promise<void>((resolve) => node.once("ready", () => resolve()));
}

/**
 * `RedlockService` against real `redis:8-alpine` nodes that can be taken away.
 *
 * `src/common/locking/distributed-lock.contract.spec.ts` runs this contract
 * against real servers when `REDLOCK_NODES` is set, and reports two `it.todo`s
 * when it is not — so on a clean clone the only lock implementation actually
 * exercised is the in-memory one. The first half of this file closes that: the
 * nodes come from `globalSetup`, so the quorum legs are unconditional.
 *
 * The second half is coverage that the workflow's service containers cannot
 * provide at all. A service runs for the length of the job; a container can be
 * stopped. The three properties below are the ones Redlock exists for, and
 * every one of them is currently asserted against a stand-in:
 *
 *  - a majority still functions when a minority is gone;
 *  - fencing tokens stay strictly increasing across that loss;
 *  - and — the safety property, the one whose failure is two holders at once —
 *    no majority means no lock.
 */
describe("RedlockService (containerised Redis)", () => {
  const urls = integrationRedisUrls();
  const [first, second, third] = urls as [string, string, string];

  describe("contract, on one node", () => {
    const nodes = [connect(first)];
    const lock = new RedlockService(nodes, { nodeTimeoutMs: 250, logger: SILENT });

    beforeAll(async () => {
      await Promise.all(nodes.map(ready));
    });

    afterAll(async () => {
      await lock.onModuleDestroy();
    });

    describeDistributedLockContract("RedlockService (single node)", () => ({
      lock,
      reset: async () => {
        await Promise.all(nodes.map((node) => node.flushdb()));
      },
    }));
  });

  describe("contract, on a three-node quorum", () => {
    const nodes = [connect(first), connect(second), connect(third)];
    const lock = new RedlockService(nodes, { nodeTimeoutMs: 250, logger: SILENT });

    beforeAll(async () => {
      await Promise.all(nodes.map(ready));
    });

    afterAll(async () => {
      await lock.onModuleDestroy();
    });

    describeDistributedLockContract("RedlockService (three nodes)", () => ({
      lock,
      reset: async () => {
        await Promise.all(nodes.map((node) => node.flushdb()));
      },
    }));
  });

  /**
   * Its own three containers, not the ones `globalSetup` started.
   *
   * This block stops a node, and a node stopped out from under the shared
   * fixture would be missing for every file that ran afterwards — the suites
   * above included. Three `redis:8-alpine` containers start in about a second
   * between them, which is a cheap price for the fixture staying a fixture.
   */
  describe("losing a node for real", () => {
    let containers: StartedRedisContainer[] = [];
    let nodes: Redis[] = [];
    let lock: RedlockService;

    beforeAll(async () => {
      containers = await Promise.all(
        Array.from({ length: 3 }, () => new RedisContainer(REDIS_IMAGE).start()),
      );
      nodes = containers.map((container) => connect(container.getConnectionUrl()));
      await Promise.all(nodes.map(ready));
      lock = new RedlockService(nodes, { nodeTimeoutMs: 250, logger: SILENT });
    }, 120_000);

    afterAll(async () => {
      await lock.onModuleDestroy();
      // Whatever is still running. `stop()` on an already-stopped container is
      // the ordinary case here, and Testcontainers treats it as a no-op.
      await Promise.allSettled(containers.map((container) => container.stop()));
    }, 120_000);

    it("keeps serving a majority when a minority has gone away, with tokens still rising", async () => {
      const before = await lock.acquire("fenced-resource", { ttlMs: TTL_MS });
      expect(before).not.toBeNull();
      await before?.release();

      // Not a paused process, not a closed port, not a fake reporting
      // `down = true`: the server is stopped and its container is gone.
      await containers[2]?.stop();

      const after = await lock.acquire("fenced-resource", { ttlMs: TTL_MS });
      expect(after).not.toBeNull();

      // The property that would quietly stop being true if the surviving
      // quorum's counters were allowed to drift: a token handed out after the
      // loss must still be above every token handed out before it, or a
      // resource that already accepted the first would accept a stale writer.
      expect(after?.fencingToken).toBeGreaterThan(before?.fencingToken ?? 0);

      // And the lock is still a lock: a second caller cannot hold it too.
      await expect(lock.acquire("fenced-resource", { ttlMs: TTL_MS })).resolves.toBeNull();
      expect(await after?.release()).toBe(true);
    });

    it("refuses the lock once no majority is left", async () => {
      // Two of three down leaves one reachable node, and one is not a majority
      // of three. Returning a lock here is the failure that puts two holders
      // inside the same critical section — so the only safe answer is none.
      //
      // Both are stopped here rather than relying on the test above having
      // stopped one: `stop()` on an already-stopped container is a no-op, and
      // this way the property holds whichever of these two runs first.
      await Promise.all([containers[1]?.stop(), containers[2]?.stop()]);

      await expect(lock.acquire("quorum-lost", { ttlMs: TTL_MS })).resolves.toBeNull();
    });
  });
});
