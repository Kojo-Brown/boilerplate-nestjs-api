import { Logger } from "@nestjs/common";
import { Redis } from "ioredis";
import { RedisIdempotencyStore, parseRecord } from "./redis-idempotency.store";
import type { InFlightRecord } from "../ports";

/**
 * What the shared contract cannot reach: what this store does with values the
 * contract would never produce.
 *
 * A record living 24 hours in a shared Redis outlives at least one deploy, so
 * "something else wrote here" and "an older version wrote this" are ordinary
 * operating conditions rather than hypotheticals.
 */
describe("RedisIdempotencyStore", () => {
  const RECORD: InFlightRecord = { state: "in-flight", fingerprint: "fp", lease: "lease-1" };

  describe("parseRecord", () => {
    it.each([
      ["not json at all", "}{"],
      ["a JSON scalar", '"just-a-string"'],
      ["null", "null"],
      ["an object with no lease", '{"state":"in-flight","fingerprint":"fp"}'],
      ["an unknown state", '{"state":"pending","fingerprint":"fp","lease":"l"}'],
      ["completed with no response", '{"state":"completed","fingerprint":"fp","lease":"l"}'],
      [
        "completed with a malformed response",
        '{"state":"completed","fingerprint":"fp","lease":"l","response":{"status":"201"}}',
      ],
    ])("rejects %s", (_why, raw) => {
      expect(parseRecord(raw)).toBeNull();
    });

    it("accepts a well-formed in-flight record", () => {
      expect(parseRecord(JSON.stringify(RECORD))).toEqual(RECORD);
    });

    it("keeps only the fields the port declares", () => {
      // A record written by a later version may carry fields this one does not
      // understand. Copying them through would let them reach the interceptor
      // as part of a value it never validated.
      const parsed = parseRecord(
        '{"state":"in-flight","fingerprint":"fp","lease":"l","extra":"ignored"}',
      );

      expect(parsed).toEqual({ state: "in-flight", fingerprint: "fp", lease: "l" });
    });
  });

  it("gives up rather than executing when a key keeps expiring mid-reservation", async () => {
    // The one case a real Redis cannot be made to reproduce on demand: `SET NX`
    // failing and the read-back finding nothing, over and over, because the TTL
    // is shorter than a round trip. Executing anyway would be the double charge
    // this module exists to prevent, so it has to refuse — and the only way to
    // schedule that reliably is a client that always answers that way.
    const alwaysExpiring = {
      defineCommand: () => undefined,
      set: async () => null,
      get: async () => null,
    } as unknown as Redis;

    await expect(
      new RedisIdempotencyStore(alwaysExpiring).reserve("user:u1:abc", RECORD, 1),
    ).rejects.toThrow(/too short to outlive a round trip/);
  });

  const REDIS_URL = process.env["REDIS_URL"];
  if (!REDIS_URL) {
    it.todo("needs a running Redis — set REDIS_URL to include the rest of this suite");
    return;
  }

  describe("against a real Redis", () => {
    /** Kept off db 0 and off the contract's db 15. */
    const client = new Redis(REDIS_URL, { db: 14, maxRetriesPerRequest: 1 });
    const store = new RedisIdempotencyStore(client);

    beforeEach(async () => {
      await client.flushdb();
    });

    afterAll(async () => {
      await store.onModuleDestroy();
    });

    it("namespaces its keys so it cannot collide with the cache or the queue", async () => {
      await store.reserve("user:u1:abc", RECORD, 5_000);

      expect(await client.keys("*")).toEqual(["idempotency:user:u1:abc"]);
    });

    it("treats a value it cannot read as an unclaimed key", async () => {
      // Better than failing every retry until the TTL clears whatever is there:
      // the request proceeds and the key is rewritten correctly.
      const warn = jest.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
      await client.set("idempotency:user:u1:abc", "written by something else");

      expect(await store.get("user:u1:abc")).toBeNull();
      expect(await store.reserve("user:u1:abc", RECORD, 5_000)).toBeNull();
      expect(warn).toHaveBeenCalled();

      warn.mockRestore();
    });

    it("refuses to complete a record whose lease has moved on, leaving the newer one intact", async () => {
      // The fencing case as Redis sees it: the Lua script decides, so the check
      // and the write cannot be interleaved by the retry that replaced us.
      await store.reserve("user:u1:abc", RECORD, 5_000);

      const completed = await store.complete(
        "user:u1:abc",
        "some-other-lease",
        { status: 200, contentType: null, body: null },
        5_000,
      );

      expect(completed).toBe(false);
      expect(await store.get("user:u1:abc")).toEqual(RECORD);
    });
  });
});
