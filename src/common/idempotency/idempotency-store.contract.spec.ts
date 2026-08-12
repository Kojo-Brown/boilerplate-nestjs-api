import { Redis } from "ioredis";
import { describeIdempotencyStoreContract } from "./idempotency-store.contract";
import { InMemoryIdempotencyStore } from "./stores/in-memory-idempotency.store";
import { RedisIdempotencyStore } from "./stores/redis-idempotency.store";

/**
 * One contract, both backends.
 *
 * This is the file that makes the store a port rather than an interface nobody
 * checks: whatever `IDEMPOTENCY_STORE` is set to, `IdempotencyInterceptor`
 * behaves the same, and a divergence shows up here rather than as a duplicate
 * charge the first time someone switches to Redis.
 */

describeIdempotencyStoreContract("InMemoryIdempotencyStore", () => {
  const store = new InMemoryIdempotencyStore();
  return { store, reset: () => store.clear() };
});

/**
 * A real `redis-server`, on a database of its own.
 *
 * Not a fake, and not `ioredis-mock`: every property this contract cares about
 * — `SET NX` settling a race between twenty concurrent claims, `PX` expiring a
 * key, a Lua script running to completion without interleaving — is a Redis
 * guarantee, so testing against something that merely implements the same
 * method names would certify nothing.
 *
 * CI runs a `redis:8-alpine` service and sets `REDIS_URL`, so this leg always
 * runs there. Locally it needs a Redis; without one the leg is reported as
 * pending rather than quietly passing.
 */
const REDIS_URL = process.env["REDIS_URL"];

/** Kept away from db 0, which the cache and BullMQ share in a dev environment. */
const CONTRACT_DB = 15;

if (REDIS_URL) {
  const client = new Redis(REDIS_URL, { db: CONTRACT_DB, maxRetriesPerRequest: 1 });
  const store = new RedisIdempotencyStore(client);

  afterAll(async () => {
    await store.onModuleDestroy();
  });

  describeIdempotencyStoreContract("RedisIdempotencyStore", () => ({
    store,
    reset: async () => {
      await client.flushdb();
    },
  }));
} else {
  describe("RedisIdempotencyStore (idempotency store contract)", () => {
    it.todo("needs a running Redis — set REDIS_URL to include this leg");
  });
}
