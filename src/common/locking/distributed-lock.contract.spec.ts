import { Redis } from "ioredis";
import { FakeRedisNode } from "@/test-utils/fake-redis-node";
import { describeDistributedLockContract } from "./distributed-lock.contract";
import { InMemoryDistributedLock } from "./in-memory-distributed-lock";
import { RedlockService } from "./redlock.service";
import { SystemLockClock } from "./ports";
import { parseRedlockNodes } from "./locking.module";

/**
 * One contract, every implementation — and, for Redlock, every topology worth
 * distinguishing.
 *
 * This is the file that makes the lock a port rather than an interface nobody
 * checks: whatever `DISTRIBUTED_LOCK` is set to, `@Lock()` behaves the same,
 * and a divergence shows up here rather than as two workers running the same
 * job the first time someone switches to Redis.
 */

describeDistributedLockContract("InMemoryDistributedLock", () => {
  const lock = new InMemoryDistributedLock();
  return { lock, reset: () => lock.clear() };
});

/**
 * Real `redis-server` processes, on a database of their own.
 *
 * Not a fake, and not `ioredis-mock`: every property this contract cares about
 * — `SET NX` settling a race between twenty simultaneous callers, `PX`
 * expiring a lease, a Lua script comparing a holder's value and deleting in one
 * indivisible step — is a Redis guarantee. Testing against something that
 * merely implements the same method names would certify nothing.
 *
 * CI runs three independent `redis:8-alpine` services and sets `REDLOCK_NODES`,
 * so the quorum legs always run there. Locally, `REDIS_URL` alone gets the
 * single-node leg; without either, the legs are reported as pending rather than
 * quietly passing.
 */
const NODE_URLS = parseRedlockNodes(process.env["REDLOCK_NODES"] ?? process.env["REDIS_URL"] ?? "");

/**
 * Kept away from db 0, which the cache and BullMQ share in a dev environment,
 * and away from db 15, which `idempotency-store.contract.spec.ts` uses.
 *
 * The separation has to be a database rather than a key prefix: `reset()` here
 * is a `FLUSHDB`, which knows nothing about prefixes, and Jest runs the two
 * contract suites in parallel workers against the same server. Sharing db 15
 * made this suite delete the idempotency suite's records mid-test — which is
 * how it failed in CI while passing locally, where the two happened not to
 * overlap.
 */
const CONTRACT_DB = 14;

function connect(url: string): Redis {
  return new Redis(url, {
    db: CONTRACT_DB,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    // ioredis emits `error` on every reconnect attempt, and an unhandled one
    // on an EventEmitter would take the test process down.
  }).on("error", () => {});
}

/**
 * A node that is down, without a socket to clean up afterwards.
 *
 * Pointing a real client at a closed port also works and is what an operator
 * would see — but ioredis then keeps a connect attempt and its retry timer
 * alive past the end of the suite, and Jest reports the worker as leaking. What
 * this leg is actually about is the *quorum* surviving a missing vote, and the
 * two nodes that answer are real servers either way.
 */
function downNode(): Redis {
  const node = new FakeRedisNode(new SystemLockClock());
  node.down = true;
  return node.asRedis();
}

function runContract(name: string, urls: string[], withNodeDown = false): void {
  const reachable = urls.map(connect);
  const nodes = withNodeDown ? [...reachable, downNode()] : reachable;
  const lock = new RedlockService(nodes, {
    // The backstop for a node that accepts a connection and then says nothing;
    // one that refuses outright already rejects at once.
    nodeTimeoutMs: 250,
    logger: { debug: () => {}, warn: () => {} },
  });

  beforeAll(async () => {
    // `enableOfflineQueue: false` means a command sent before the socket is up
    // fails rather than queueing, so the suite waits for the connections it is
    // about to vote over. `LockingModule` does the same at boot.
    await Promise.all(
      reachable.map(
        (node) =>
          new Promise<void>((resolve) => {
            if (node.status === "ready") resolve();
            else node.once("ready", () => resolve());
          }),
      ),
    );
  });

  afterAll(async () => {
    await lock.onModuleDestroy();
  });

  describeDistributedLockContract(name, () => ({
    lock,
    reset: async () => {
      await Promise.all(reachable.map((node) => node.flushdb()));
    },
  }));
}

if (NODE_URLS.length >= 3) {
  const [first, second, third] = NODE_URLS as [string, string, string];

  runContract("RedlockService (single node)", [first]);
  runContract("RedlockService (three nodes)", [first, second, third]);
  // The configuration the algorithm exists for. Two of three still form a
  // majority, so every property above must hold with a node down — including
  // the fencing tokens staying monotonic, which is the one that would quietly
  // stop being true if the quorum's counters were allowed to drift apart.
  runContract("RedlockService (three nodes, one down)", [first, second], true);
} else if (NODE_URLS.length > 0) {
  runContract("RedlockService (single node)", [NODE_URLS[0] as string]);

  describe("RedlockService (quorum topologies)", () => {
    it.todo("needs three independent Redis nodes — set REDLOCK_NODES to include these legs");
  });
} else {
  describe("RedlockService (distributed lock contract)", () => {
    it.todo("needs a running Redis — set REDIS_URL or REDLOCK_NODES to include these legs");
  });
}
