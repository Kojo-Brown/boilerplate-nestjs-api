import { Redis } from "ioredis";
import { describeIdempotencyStoreContract } from "@/common/idempotency/idempotency-store.contract";
import { RedisIdempotencyStore } from "@/common/idempotency/stores/redis-idempotency.store";
import type { InFlightRecord, RecordedResponse } from "@/common/idempotency/ports";
import { REDIS_TEST_DATABASES } from "@/test-utils/redis-test-databases";
import { integrationRedisUrl } from "./containers";

const KEY = "user:u1:integration";

const RESPONSE: RecordedResponse = {
  status: 201,
  contentType: "application/json; charset=utf-8",
  body: '{"success":true,"data":{"id":"u1"}}',
};

function inFlight(lease: string): InFlightRecord {
  return { state: "in-flight", fingerprint: "fingerprint-aaa", lease };
}

/**
 * `RedisIdempotencyStore` against a containerised `redis:8-alpine`.
 *
 * `src/common/idempotency/idempotency-store.contract.spec.ts` already runs this
 * contract against a real server — *when* `REDIS_URL` happens to be set. When
 * it is not, which is every clean clone and every local run, the Redis leg
 * becomes a single `it.todo` and the suite passes green having checked a `Map`.
 * That is the gap this file closes: the server is started by `globalSetup`, so
 * there is no branch and nothing to configure.
 *
 * The suites below the contract are the ones that need the server for a reason
 * no amount of configuration would supply — a key that expires because a real
 * clock reclaimed it, and a race decided by a real `SET NX`.
 */
describe("RedisIdempotencyStore (containerised Redis)", () => {
  const client = new Redis(integrationRedisUrl(), {
    db: REDIS_TEST_DATABASES.idempotencyStoreIntegration,
    maxRetriesPerRequest: 1,
  });
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

  describe("expiry, as the server decides it", () => {
    beforeEach(async () => {
      await client.flushdb();
    });

    it("sets a TTL the server honours rather than one only the record carries", async () => {
      await store.reserve(KEY, inFlight("lease-1"), 5_000);

      // `PTTL` is the server's own answer, so this is the assertion the
      // in-memory double cannot make: it would be reporting its own bookkeeping.
      const ttl = await client.pttl(`idempotency:${KEY}`);
      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(5_000);
    });

    it("frees a key once its lease elapses, so a later caller may claim it", async () => {
      expect(await store.reserve(KEY, inFlight("lease-1"), 60)).toBeNull();
      // Still held: the point of the reservation.
      expect(await store.reserve(KEY, inFlight("lease-2"), 60)).toEqual(inFlight("lease-1"));

      await new Promise((resolve) => setTimeout(resolve, 150));

      // Nothing released this key. Redis reclaimed it, which is what the whole
      // design rests on — a replica that dies mid-request must not hold a key
      // forever, and no code path in this store would ever free it.
      expect(await store.get(KEY)).toBeNull();
      expect(await store.reserve(KEY, inFlight("lease-3"), 5_000)).toBeNull();
    });

    it("keeps a completed record readable for its own TTL", async () => {
      await store.reserve(KEY, inFlight("lease-1"), 5_000);
      expect(await store.complete(KEY, "lease-1", RESPONSE, 5_000)).toBe(true);

      // `complete` rewrites the key with `PX`, so a resolved record expires too
      // — a dedupe window that never closed would be a memory leak with a
      // retention policy attached.
      expect(await client.pttl(`idempotency:${KEY}`)).toBeGreaterThan(0);
      await expect(store.get(KEY)).resolves.toMatchObject({
        state: "completed",
        response: RESPONSE,
      });
    });
  });

  describe("a race the server settles", () => {
    beforeEach(async () => {
      await client.flushdb();
    });

    it("admits exactly one of twenty simultaneous reservations", async () => {
      // The reason this store is tested against a server at all. Twenty
      // `SET NX` commands arrive on twenty connections and Redis orders them;
      // exactly one may be told the key was free, because the second caller
      // being told that is a double charge.
      const contenders = Array.from({ length: 20 }, (_, index) => `lease-${index}`);

      const outcomes = await Promise.all(
        contenders.map((lease) => store.reserve(KEY, inFlight(lease), 10_000)),
      );

      const winners = outcomes.filter((outcome) => outcome === null);
      expect(winners).toHaveLength(1);

      // And the nineteen losers were all handed the same record — the winner's.
      const losers = outcomes.filter((outcome) => outcome !== null);
      const leases = new Set(losers.map((record) => record?.lease));
      expect(leases.size).toBe(1);

      // And that one lease is the winner's: the record every loser was handed
      // is the record actually sitting on the key.
      const held = await store.get(KEY);
      expect([...leases]).toEqual([held?.lease]);
    });

    it("lets only the holder resolve a key when many try at once", async () => {
      await store.reserve(KEY, inFlight("holder"), 10_000);

      // `complete` is a Lua script, which Redis runs to completion without
      // interleaving. Nineteen impostors and the holder race it; the script is
      // what makes "check the lease, then write" one step rather than two with
      // a gap a retry could land in.
      const attempts = await Promise.all([
        ...Array.from({ length: 19 }, (_, index) =>
          store.complete(
            KEY,
            `impostor-${index}`,
            { status: 500, contentType: null, body: null },
            10_000,
          ),
        ),
        store.complete(KEY, "holder", RESPONSE, 10_000),
      ]);

      expect(attempts.filter((accepted) => accepted)).toEqual([true]);
      await expect(store.get(KEY)).resolves.toEqual({
        state: "completed",
        fingerprint: "fingerprint-aaa",
        lease: "holder",
        response: RESPONSE,
      });
    });
  });
});
