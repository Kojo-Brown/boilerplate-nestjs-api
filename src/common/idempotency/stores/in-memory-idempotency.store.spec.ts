import { InMemoryIdempotencyStore } from "./in-memory-idempotency.store";
import type { InFlightRecord } from "../ports";

/**
 * What the shared contract cannot reach: this store's role as the default a
 * clean clone boots on, and as the double every e2e suite runs against.
 *
 * The contract proves it behaves like the Redis one. These cover the properties
 * that make it usable at all — an isolated map per instance, an expiry that
 * does not rely on timers, and a `clear()` that really empties it.
 */
describe("InMemoryIdempotencyStore", () => {
  const RECORD: InFlightRecord = { state: "in-flight", fingerprint: "fp", lease: "lease-1" };

  it("keeps each instance's records to itself", async () => {
    // Module-level state here would make one suite's reservations visible to
    // another's, which is the classic way an in-memory double stops being a
    // reliable fixture.
    const store = new InMemoryIdempotencyStore();
    await store.reserve("shared", RECORD, 5_000);

    expect(await new InMemoryIdempotencyStore().get("shared")).toBeNull();
  });

  it("empties on clear()", async () => {
    const store = new InMemoryIdempotencyStore();
    await store.reserve("k", RECORD, 5_000);

    store.clear();

    expect(await store.get("k")).toBeNull();
  });

  it("expires against the injected clock rather than a timer", async () => {
    // A `setTimeout` per key would keep the event loop alive and make a
    // graceful shutdown wait out the TTL — 24 hours by default. Sweeping on
    // read is what avoids that, and this is the test that pins it: no real
    // time passes here at all.
    let now = 1_000;
    const store = new InMemoryIdempotencyStore(() => now);
    await store.reserve("k", RECORD, 60_000);

    now += 59_999;
    expect(await store.get("k")).toEqual(RECORD);

    now += 1;
    expect(await store.get("k")).toBeNull();
  });

  it("drops an expired entry rather than leaving it to accumulate", async () => {
    // The sweep is lazy, so the only thing that reclaims memory is a read of
    // the same key. Reserving after expiry has to overwrite, not append.
    let now = 0;
    const store = new InMemoryIdempotencyStore(() => now);
    await store.reserve("k", RECORD, 10);

    now = 20;
    expect(await store.reserve("k", { ...RECORD, lease: "lease-2" }, 10)).toBeNull();
    expect((await store.get("k"))?.lease).toBe("lease-2");
  });
});
