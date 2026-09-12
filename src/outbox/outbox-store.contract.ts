import type { TransactionContext, TransactionRunner } from "@/common/prisma/transaction.port";
import { EMPTY_TRACE_CARRIER } from "@/telemetry";
import type { DrainOptions, NewOutboxEvent, OutboxRecord, OutboxStore } from ".";

/** What a suite must supply to run the contract. */
export interface OutboxStoreHarness {
  readonly store: OutboxStore;
  /** Opens a unit of work the store can stage into. */
  readonly transactions: TransactionRunner;
  /**
   * A second relay's view of the same outbox, for the concurrency case.
   *
   * For Postgres it has to be a store on its own **connection**: two
   * `$transaction` calls on one client can be served by the same pooled
   * connection and would then serialise for the wrong reason, so the claim test
   * would pass with `SKIP LOCKED` doing nothing at all. For the in-memory
   * double there are no connections and this is the same instance — two
   * overlapping `drain` calls on one `Map` is exactly the contention it has.
   */
  readonly other: { readonly store: OutboxStore };
}

const HOUR = 3_600_000;

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/**
 * The behavioural contract every outbox store must satisfy.
 *
 * Written once and run against both implementations — against Postgres in
 * `test/outbox-store.db-spec.ts`, and against the in-memory double in
 * `outbox-store.contract.spec.ts`. The signatures already type-check; what this
 * pins is the behaviour a plausible fake would get wrong, and there are three
 * such properties:
 *
 * 1. a staged event disappears with its transaction;
 * 2. a claimed row is not handed to a second, concurrent drain;
 * 3. a failed delivery comes back later rather than being lost or retried
 *    immediately.
 *
 * Asserted only against Postgres, nothing would stop the double the e2e suite
 * runs the whole application on from breaking all three. Asserted only against
 * the double, they would be properties of a `Map`.
 */
export function describeOutboxStoreContract(
  name: string,
  createHarness: () => Promise<OutboxStoreHarness>,
): void {
  describe(`${name} (outbox store contract)`, () => {
    let harness: OutboxStoreHarness;
    let sequence = 0;

    /**
     * Only the envelope is overridable. `name` and `payload` are fixed together
     * or not at all — they are correlated, and a `Partial<NewOutboxEvent>` would
     * happily let a caller replace one of them and leave the other.
     */
    type EnvelopeOverrides = Partial<
      Pick<NewOutboxEvent, "eventId" | "occurredAt" | "correlationId" | "trace">
    >;

    const event = (overrides: EnvelopeOverrides = {}): NewOutboxEvent<"user.registered"> => ({
      eventId: `evt-${(sequence += 1)}-${process.pid}`,
      name: "user.registered",
      payload: {
        userId: "user-1",
        email: "staged@example.test",
        name: "Ada",
        provider: null,
      },
      correlationId: null,
      trace: EMPTY_TRACE_CARRIER,
      occurredAt: new Date(Date.now() - HOUR),
      ...overrides,
    });

    const stage = async (overrides: EnvelopeOverrides = {}) => {
      const staged = event(overrides);
      await harness.transactions.run((tx) => harness.store.stage(tx, staged));
      return staged;
    };

    /** A drain that records what it was asked to deliver and always succeeds. */
    const drainCollecting = async (
      store: OutboxStore = harness.store,
      overrides: Partial<DrainOptions> = {},
    ) => {
      const delivered: OutboxRecord[] = [];
      const report = await store.drain({
        now: new Date(),
        batchSize: 10,
        deliver: (record) => {
          delivered.push(record);
          return Promise.resolve();
        },
        retryAt: () => new Date(Date.now() + HOUR),
        ...overrides,
      });
      return { delivered, report };
    };

    beforeEach(async () => {
      harness = await createHarness();
    });

    describe("stage()", () => {
      it("makes the event visible to a later drain", async () => {
        const staged = await stage();

        const { delivered } = await drainCollecting();

        expect(delivered.map((record) => record.eventId)).toEqual([staged.eventId]);
      });

      it("preserves the id, name, payload and time it was staged with", async () => {
        const occurredAt = new Date(Date.now() - HOUR);
        const staged = await stage({ occurredAt, correlationId: "corr-1" });

        const { delivered } = await drainCollecting();

        expect(delivered[0]).toMatchObject({
          eventId: staged.eventId,
          name: "user.registered",
          payload: staged.payload,
          correlationId: "corr-1",
        });
        // The relay publishes this as `occurredAt`, so it has to be when the
        // transaction staged the event and not when the poller got to it.
        expect(delivered[0]?.occurredAt.getTime()).toBe(occurredAt.getTime());
      });

      it("discards the event when the unit of work fails", async () => {
        await expect(
          harness.transactions.run(async (tx: TransactionContext) => {
            await harness.store.stage(tx, event());
            throw new Error("the write that came after it failed");
          }),
        ).rejects.toThrow("the write that came after it failed");

        const { delivered } = await drainCollecting();
        expect(delivered).toEqual([]);
        await expect(harness.store.countByStatus()).resolves.toMatchObject({ PENDING: 0 });
      });

      /**
       * The property the `traceparent`/`tracestate` columns exist for.
       *
       * The relay reads this back to parent the published message to the
       * request that staged the event — see `docs/telemetry.md` — so a store
       * that dropped it, or normalised it, would leave every event in the
       * system hanging off whichever poll happened to claim its row. The value
       * is opaque and must come back byte for byte: `tracestate` carries
       * vendor entries this service has never heard of.
       */
      it("returns the trace context it was staged with, unchanged", async () => {
        const trace = {
          traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
          tracestate: "vendor=t61rcWkgMzE,other=value",
        };
        await stage({ trace });

        const { delivered } = await drainCollecting();

        expect(delivered[0]?.trace).toEqual(trace);
      });

      it("reads back an absent trace context as nulls rather than undefined", async () => {
        await stage({ trace: EMPTY_TRACE_CARRIER });

        const { delivered } = await drainCollecting();

        expect(delivered[0]?.trace).toEqual({ traceparent: null, tracestate: null });
      });

      it("reports the first attempt as attempt zero", async () => {
        await stage();

        const { delivered } = await drainCollecting();

        expect(delivered[0]?.attempts).toBe(0);
      });
    });

    describe("drain()", () => {
      it("claims nothing, and reports so, when the outbox is empty", async () => {
        const { report } = await drainCollecting();

        expect(report).toEqual({ claimed: 0, outcomes: [] });
      });

      it("marks a delivered event published, and never delivers it again", async () => {
        await stage();

        const first = await drainCollecting();
        const second = await drainCollecting();

        expect(first.report.outcomes).toEqual([
          expect.objectContaining({ disposition: "published" }),
        ]);
        expect(second.delivered).toEqual([]);
        await expect(harness.store.countByStatus()).resolves.toMatchObject({
          PENDING: 0,
          PUBLISHED: 1,
        });
      });

      it("honours the batch size", async () => {
        await stage();
        await stage();
        await stage();

        const { delivered } = await drainCollecting(harness.store, { batchSize: 2 });

        expect(delivered).toHaveLength(2);
      });

      it("delivers in the order things happened", async () => {
        const older = await stage({ occurredAt: new Date(Date.now() - 2 * HOUR) });
        const newer = await stage({ occurredAt: new Date(Date.now() - HOUR) });

        const { delivered } = await drainCollecting();

        expect(delivered.map((record) => record.eventId)).toEqual([older.eventId, newer.eventId]);
      });

      it("leaves a failed event pending, due later, with its attempts counted", async () => {
        await stage();
        const retryAt = new Date(Date.now() + HOUR);

        const report = await harness.store.drain({
          now: new Date(),
          batchSize: 10,
          deliver: () => Promise.reject(new Error("broker unreachable")),
          retryAt: () => retryAt,
        });

        expect(report.outcomes).toEqual([
          expect.objectContaining({ disposition: "retry", error: "broker unreachable" }),
        ]);
        await expect(harness.store.countByStatus()).resolves.toMatchObject({ PENDING: 1 });

        // Due later, so a drain now sees nothing…
        const immediately = await drainCollecting();
        expect(immediately.delivered).toEqual([]);

        // …and one after the backoff sees it, on its second attempt.
        const later = await drainCollecting(harness.store, {
          now: new Date(retryAt.getTime() + 1),
        });
        expect(later.delivered[0]?.attempts).toBe(1);
      });

      it("dead-letters an event whose retry policy has given up", async () => {
        await stage();

        const report = await harness.store.drain({
          now: new Date(),
          batchSize: 10,
          deliver: () => Promise.reject(new Error("poison")),
          retryAt: () => null,
        });

        expect(report.outcomes).toEqual([
          expect.objectContaining({ disposition: "dead", error: "poison" }),
        ]);
        await expect(harness.store.countByStatus()).resolves.toMatchObject({
          PENDING: 0,
          DEAD: 1,
        });

        // Terminal: a dead letter is not picked up again by a later poll.
        const { delivered } = await drainCollecting();
        expect(delivered).toEqual([]);
      });

      it("does not lose the rest of the batch when one event fails", async () => {
        const first = await stage({ occurredAt: new Date(Date.now() - 2 * HOUR) });
        const second = await stage({ occurredAt: new Date(Date.now() - HOUR) });

        const report = await harness.store.drain({
          now: new Date(),
          batchSize: 10,
          deliver: (record) =>
            record.eventId === first.eventId
              ? Promise.reject(new Error("just this one"))
              : Promise.resolve(),
          retryAt: () => new Date(Date.now() + HOUR),
        });

        expect(report.claimed).toBe(2);
        expect(report.outcomes).toEqual([
          expect.objectContaining({ eventId: first.eventId, disposition: "retry" }),
          expect.objectContaining({ eventId: second.eventId, disposition: "published" }),
        ]);
      });
    });

    describe("concurrent relays", () => {
      /**
       * The property `FOR UPDATE SKIP LOCKED` exists for.
       *
       * Two relays drain at once. The first is held inside `deliver` while the
       * second runs to completion, so the second genuinely overlaps the first's
       * claim rather than following it. Nothing may be delivered twice — that
       * would be a duplicate side effect on every replica of a scaled-out
       * deployment.
       */
      it("never hands the same event to two overlapping drains", async () => {
        await stage({ occurredAt: new Date(Date.now() - 2 * HOUR) });
        await stage({ occurredAt: new Date(Date.now() - HOUR) });

        const firstEnteredDelivery = deferred<void>();
        const releaseFirstDelivery = deferred<void>();
        const seenByFirst: string[] = [];

        const first = harness.store.drain({
          now: new Date(),
          batchSize: 10,
          deliver: async (record) => {
            seenByFirst.push(record.eventId);
            firstEnteredDelivery.resolve();
            await releaseFirstDelivery.promise;
          },
          retryAt: () => new Date(Date.now() + HOUR),
        });

        // The second drain overlaps the first's claim rather than following it.
        await firstEnteredDelivery.promise;
        const second = await drainCollecting(harness.other.store);
        releaseFirstDelivery.resolve();
        await first;

        expect(seenByFirst.length).toBeGreaterThan(0);
        for (const record of second.delivered) {
          expect(seenByFirst).not.toContain(record.eventId);
        }
      });
    });
  });
}
