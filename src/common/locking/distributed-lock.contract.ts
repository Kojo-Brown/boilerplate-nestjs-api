import type { DistributedLock } from "./ports";

/**
 * The behavioural contract every distributed lock must satisfy.
 *
 * `DISTRIBUTED_LOCK` selects an implementation from an environment variable, so
 * everything downstream — `@Lock()`, every `withLock()` call site — must behave
 * identically whichever one it gets (LSP). The type system checks one
 * signature; what actually lets two callers into the same critical section is
 * behaviour: an `acquire` that answers twice for one key, an `extend` that
 * renews a lease which had already lapsed, a `release` that drops a successor's
 * lock.
 *
 * So the contract lives here once and `distributed-lock.contract.spec.ts` runs
 * it against the in-memory implementation and against Redlock over real
 * `redis-server` processes — including a three-node quorum with one node
 * unreachable, which is the configuration the whole algorithm exists for.
 *
 * Timing is deliberately real rather than faked here. Every property below is
 * about a lease actually elapsing, and a fake clock that both the test and the
 * implementation read would prove only that they agree with each other. TTLs
 * are kept in the low hundreds of milliseconds so the suite stays quick.
 */
export interface DistributedLockHarness {
  readonly lock: DistributedLock;
  /** Returns the backend to empty. Called before every test. */
  reset(): Promise<void> | void;
}

const KEY = "orders:o-1";
const OTHER_KEY = "orders:o-2";
/**
 * The lease for tests that only need the lock to still be held at the end.
 *
 * Generous on purpose: a lease that lapses mid-test would let a second caller
 * in and fail an assertion about exclusion for a reason that has nothing to do
 * with exclusion. Tests that are *about* expiry set their own short TTL.
 */
const TTL_MS = 2_000;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function describeDistributedLockContract(
  name: string,
  createHarness: () => DistributedLockHarness,
): void {
  describe(`${name} (distributed lock contract)`, () => {
    let lock: DistributedLock;

    beforeEach(async () => {
      const harness = createHarness();
      lock = harness.lock;
      await harness.reset();
    });

    describe("acquire", () => {
      it("takes a free key and issues a fencing token", async () => {
        const held = await lock.acquire(KEY, { ttlMs: TTL_MS });

        expect(held).not.toBeNull();
        expect(held?.key).toBe(KEY);
        expect(held?.fencingToken).toBeGreaterThan(0);
        expect(held?.remainingMs()).toBeGreaterThan(0);
      });

      it("refuses a key somebody else holds", async () => {
        await lock.acquire(KEY, { ttlMs: TTL_MS });

        expect(await lock.acquire(KEY, { ttlMs: TTL_MS })).toBeNull();
      });

      it("holds different keys independently", async () => {
        await lock.acquire(KEY, { ttlMs: TTL_MS });

        expect(await lock.acquire(OTHER_KEY, { ttlMs: TTL_MS })).not.toBeNull();
      });

      it("lets exactly one of twenty simultaneous callers in", async () => {
        const results = await Promise.all(
          Array.from({ length: 20 }, () => lock.acquire(KEY, { ttlMs: TTL_MS })),
        );

        expect(results.filter((held) => held !== null)).toHaveLength(1);
      });

      it("gives the key up on its own once the lease lapses", async () => {
        // The property a lock without a TTL does not have: a holder that
        // crashes releases nothing, so the lease has to do it.
        await lock.acquire(KEY, { ttlMs: 150 });
        await delay(250);

        expect(await lock.acquire(KEY, { ttlMs: TTL_MS })).not.toBeNull();
      });

      it("waits for a held key when the caller has a budget for it", async () => {
        const first = await lock.acquire(KEY, { ttlMs: 150 });

        const second = await lock.acquire(KEY, { ttlMs: TTL_MS, waitMs: 2_000, retryDelayMs: 25 });

        expect(second).not.toBeNull();
        expect(second?.fencingToken).toBeGreaterThan(first?.fencingToken as number);
      });

      it("gives up once the wait budget is spent", async () => {
        await lock.acquire(KEY, { ttlMs: 5_000 });

        expect(
          await lock.acquire(KEY, { ttlMs: TTL_MS, waitMs: 100, retryDelayMs: 20 }),
        ).toBeNull();
      });
    });

    describe("fencing tokens", () => {
      it("issues strictly increasing tokens, across keys as well as within one", async () => {
        const first = await lock.acquire(KEY, { ttlMs: TTL_MS });
        await first?.release();
        const second = await lock.acquire(OTHER_KEY, { ttlMs: TTL_MS });
        await second?.release();
        const third = await lock.acquire(KEY, { ttlMs: TTL_MS });

        // Monotonic across the whole lock service, not per key. A token only
        // has to exceed every token issued before it, and a single sequence
        // gives that without a counter per key — see the note in ACQUIRE.
        expect(second?.fencingToken).toBeGreaterThan(first?.fencingToken as number);
        expect(third?.fencingToken).toBeGreaterThan(second?.fencingToken as number);
      });

      it("keeps increasing across an expiry, which is when fencing matters", async () => {
        // The scenario the token exists for: the first holder is still running,
        // believing it holds the lock, while the second one takes it.
        const stalled = await lock.acquire(KEY, { ttlMs: 150 });
        await delay(250);
        const successor = await lock.acquire(KEY, { ttlMs: TTL_MS });

        expect(successor?.fencingToken).toBeGreaterThan(stalled?.fencingToken as number);
      });

      it("does not change the token when the lease is extended", async () => {
        const held = await lock.acquire(KEY, { ttlMs: TTL_MS });
        const before = held?.fencingToken;

        await held?.extend(TTL_MS);

        // The token identifies the acquisition, not the lease: a resource that
        // has accepted a write from this holder must keep accepting them.
        expect(held?.fencingToken).toBe(before);
      });
    });

    describe("extend", () => {
      it("keeps a key that would otherwise have lapsed", async () => {
        // `delay` guarantees a lower bound only, so the renewal has to have
        // room to land well inside the original lease: 100ms into a 600ms one,
        // rather than 100ms into a 200ms one, which a loaded runner overshoots.
        // The second wait then takes the total past the original expiry, so a
        // lock still held at the end can only be held because of the renewal.
        const held = await lock.acquire(KEY, { ttlMs: 600 });
        await delay(100);

        expect(await held?.extend(5_000)).toBe(true);
        await delay(700);

        expect(await lock.acquire(KEY, { ttlMs: TTL_MS })).toBeNull();
        expect(held?.remainingMs()).toBeGreaterThan(0);
      });

      it("refuses to renew a lease that has already lapsed", async () => {
        const held = await lock.acquire(KEY, { ttlMs: 150 });
        await delay(250);

        expect(await held?.extend(1_000)).toBe(false);
      });

      it("refuses to renew after the key has been taken by somebody else", async () => {
        const stalled = await lock.acquire(KEY, { ttlMs: 150 });
        await delay(250);
        await lock.acquire(KEY, { ttlMs: 5_000 });

        expect(await stalled?.extend(5_000)).toBe(false);
      });
    });

    describe("release", () => {
      it("frees the key for the next caller", async () => {
        const held = await lock.acquire(KEY, { ttlMs: 5_000 });

        expect(await held?.release()).toBe(true);
        expect(await lock.acquire(KEY, { ttlMs: TTL_MS })).not.toBeNull();
      });

      it("reports nothing to release the second time", async () => {
        const held = await lock.acquire(KEY, { ttlMs: 5_000 });
        await held?.release();

        expect(await held?.release()).toBe(false);
      });

      it("does not drop the lock a successor is holding", async () => {
        // The classic bug: a holder whose lease lapsed mid-operation finishes,
        // deletes the key by name, and lets a third caller in alongside the
        // second. Release has to be conditional on still being the holder.
        const stalled = await lock.acquire(KEY, { ttlMs: 150 });
        await delay(250);
        const successor = await lock.acquire(KEY, { ttlMs: 5_000 });

        expect(await stalled?.release()).toBe(false);
        expect(await lock.acquire(KEY, { ttlMs: TTL_MS })).toBeNull();
        expect(successor?.remainingMs()).toBeGreaterThan(0);
      });
    });
  });
}
