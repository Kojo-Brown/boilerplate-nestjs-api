import type { IdempotencyStore, InFlightRecord, RecordedResponse } from "./ports";

/**
 * The behavioural contract every idempotency store must satisfy.
 *
 * `IDEMPOTENCY_STORE` selects a store from an environment variable, so
 * everything downstream must behave identically whichever one it gets (LSP).
 * The type system checks four signatures; what actually causes a double charge
 * is behaviour — a `reserve` that returns `null` twice for one key, a
 * `complete` that ignores the lease, a TTL that is set on the reservation and
 * then forgotten when the record is resolved.
 *
 * So the contract lives here once and `idempotency-store.contract.spec.ts` runs
 * it against both implementations: the in-memory one directly, and the Redis
 * one against a real `redis-server` — not a fake, because everything worth
 * testing here is a Redis guarantee. `SET NX` deciding a race and a Lua script
 * running without interleaving are not properties a stand-in can have.
 *
 * The harness supplies the store and a reset, because "start from empty" is the
 * one thing that genuinely differs: a `Map.clear()` against a `FLUSHDB`.
 */
export interface IdempotencyStoreHarness {
  readonly store: IdempotencyStore;
  /** Returns the backend to empty. Called before every test. */
  reset(): Promise<void> | void;
}

const KEY = "user:u1:key-abc";
const FINGERPRINT = "fingerprint-aaa";
const OTHER_FINGERPRINT = "fingerprint-bbb";
const TTL_MS = 5_000;

const RESPONSE: RecordedResponse = {
  status: 201,
  contentType: "application/json; charset=utf-8",
  body: '{"success":true,"data":{"id":"u1"}}',
};

function inFlight(lease: string, fingerprint = FINGERPRINT): InFlightRecord {
  return { state: "in-flight", fingerprint, lease };
}

export function describeIdempotencyStoreContract(
  name: string,
  createHarness: () => IdempotencyStoreHarness,
): void {
  describe(`${name} (idempotency store contract)`, () => {
    let store: IdempotencyStore;

    beforeEach(async () => {
      const harness = createHarness();
      store = harness.store;
      await harness.reset();
    });

    describe("reserve", () => {
      it("claims a free key and reports it as unclaimed", async () => {
        expect(await store.reserve(KEY, inFlight("lease-1"), TTL_MS)).toBeNull();
      });

      it("refuses a second claim and hands back the record already there", async () => {
        await store.reserve(KEY, inFlight("lease-1"), TTL_MS);

        // The single most important assertion in this file: whichever store is
        // selected, exactly one caller may be told the key was free.
        expect(await store.reserve(KEY, inFlight("lease-2"), TTL_MS)).toEqual(inFlight("lease-1"));
      });

      it("keeps keys apart", async () => {
        await store.reserve(KEY, inFlight("lease-1"), TTL_MS);

        expect(await store.reserve("user:u1:other", inFlight("lease-2"), TTL_MS)).toBeNull();
      });

      it("lets exactly one of a burst of concurrent claims through", async () => {
        // The reason `reserve` is a store method rather than a get-then-set in
        // the interceptor. Anything less than atomic passes the sequential test
        // above and fails this one.
        const outcomes = await Promise.all(
          Array.from({ length: 20 }, (_, index) =>
            store.reserve(KEY, inFlight(`lease-${index}`), TTL_MS),
          ),
        );

        expect(outcomes.filter((outcome) => outcome === null)).toHaveLength(1);
      });

      it("frees the key once its TTL has passed", async () => {
        await store.reserve(KEY, inFlight("lease-1"), 30);
        await sleep(60);

        expect(await store.reserve(KEY, inFlight("lease-2"), TTL_MS)).toBeNull();
      });

      it("returns a completed record rather than the reservation it replaced", async () => {
        await store.reserve(KEY, inFlight("lease-1"), TTL_MS);
        await store.complete(KEY, "lease-1", RESPONSE, TTL_MS);

        expect(await store.reserve(KEY, inFlight("lease-2"), TTL_MS)).toEqual({
          state: "completed",
          fingerprint: FINGERPRINT,
          lease: "lease-1",
          response: RESPONSE,
        });
      });
    });

    describe("complete", () => {
      it("stores the response verbatim", async () => {
        await store.reserve(KEY, inFlight("lease-1"), TTL_MS);

        expect(await store.complete(KEY, "lease-1", RESPONSE, TTL_MS)).toBe(true);
        const record = await store.get(KEY);
        expect(record).toEqual({
          state: "completed",
          fingerprint: FINGERPRINT,
          lease: "lease-1",
          response: RESPONSE,
        });
      });

      it("keeps the fingerprint the key was reserved with", async () => {
        // The interceptor compares a retry's fingerprint against this value, so
        // a store that dropped or replaced it would let one key answer two
        // different requests.
        await store.reserve(KEY, inFlight("lease-1", OTHER_FINGERPRINT), TTL_MS);
        await store.complete(KEY, "lease-1", RESPONSE, TTL_MS);

        expect((await store.get(KEY))?.fingerprint).toBe(OTHER_FINGERPRINT);
      });

      it("round-trips a body-less response", async () => {
        // A 204 has no body and no content type, and `null` has to survive the
        // trip — a store that turned it into `""` would replay a 204 carrying a
        // zero-length JSON body.
        const noContent: RecordedResponse = { status: 204, contentType: null, body: null };
        await store.reserve(KEY, inFlight("lease-1"), TTL_MS);
        await store.complete(KEY, "lease-1", noContent, TTL_MS);

        const record = await store.get(KEY);
        expect(record?.state === "completed" && record.response).toEqual(noContent);
      });

      it("refuses a lease that does not match", async () => {
        await store.reserve(KEY, inFlight("lease-1"), TTL_MS);

        expect(await store.complete(KEY, "lease-2", RESPONSE, TTL_MS)).toBe(false);
        expect((await store.get(KEY))?.state).toBe("in-flight");
      });

      it("refuses a key nobody reserved", async () => {
        expect(await store.complete(KEY, "lease-1", RESPONSE, TTL_MS)).toBe(false);
        expect(await store.get(KEY)).toBeNull();
      });

      it("restarts the TTL from the moment the response is recorded", async () => {
        // Otherwise a slow handler would leave the replayable record alive for
        // only the remainder of the reservation's window, and two clients
        // retrying the same operation seconds apart would get different
        // answers depending on how long the original took.
        await store.reserve(KEY, inFlight("lease-1"), 60);
        await sleep(40);
        await store.complete(KEY, "lease-1", RESPONSE, 5_000);
        await sleep(40);

        expect((await store.get(KEY))?.state).toBe("completed");
      });

      it("lets the completed record expire in its turn", async () => {
        await store.reserve(KEY, inFlight("lease-1"), TTL_MS);
        await store.complete(KEY, "lease-1", RESPONSE, 30);
        await sleep(60);

        expect(await store.get(KEY)).toBeNull();
      });
    });

    describe("release", () => {
      it("frees a key the caller holds", async () => {
        await store.reserve(KEY, inFlight("lease-1"), TTL_MS);

        expect(await store.release(KEY, "lease-1")).toBe(true);
        expect(await store.reserve(KEY, inFlight("lease-2"), TTL_MS)).toBeNull();
      });

      it("refuses a lease that does not match", async () => {
        // The fencing case. A request that outlived its reservation must not be
        // able to delete the retry that replaced it — that would let a third
        // attempt run while the second is still going.
        await store.reserve(KEY, inFlight("lease-1"), TTL_MS);

        expect(await store.release(KEY, "stale-lease")).toBe(false);
        expect((await store.get(KEY))?.lease).toBe("lease-1");
      });

      it("refuses a key nobody reserved", async () => {
        expect(await store.release(KEY, "lease-1")).toBe(false);
      });
    });

    describe("get", () => {
      it("returns null for a key that was never reserved", async () => {
        expect(await store.get("never-seen")).toBeNull();
      });

      it("claims nothing", async () => {
        await store.get(KEY);

        expect(await store.reserve(KEY, inFlight("lease-1"), TTL_MS)).toBeNull();
      });
    });
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
