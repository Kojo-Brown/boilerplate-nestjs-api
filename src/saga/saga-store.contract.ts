import { randomUUID } from "crypto";
import type { TransactionRunner } from "@/common/prisma/transaction.port";
import type { SagaProgress, SagaStepLogEntry } from "./saga-instance";
import type { SagaStore } from "./ports";

/** What a suite must supply to run the contract. */
export interface SagaStoreHarness {
  readonly store: SagaStore;
  /** Opens a unit of work the store can create into. */
  readonly transactions: TransactionRunner;
  /**
   * A second runner's view of the same table, for the concurrency case.
   *
   * For Postgres it has to be a store on its own **connection**, for the reason
   * the outbox contract gives: two statements on one client can be served by
   * the same pooled connection and would then serialise for the wrong reason,
   * so the claim test would pass with `SKIP LOCKED` doing nothing. For the
   * in-memory double there are no connections and this is the same instance.
   */
  readonly other: { readonly store: SagaStore };
}

const MINUTE = 60_000;

function entry(step: string, attempt = 1): SagaStepLogEntry {
  return {
    step,
    direction: "forward",
    outcome: "completed",
    attempt,
    at: new Date().toISOString(),
  };
}

function progress(overrides: Partial<SagaProgress> = {}): SagaProgress {
  return {
    status: "RUNNING",
    cursor: 1,
    attempts: 0,
    nextAttemptAt: new Date(),
    state: { seen: "one" },
    entry: entry("one"),
    lastError: null,
    release: false,
    ...overrides,
  };
}

/**
 * The behavioural contract every saga store must satisfy.
 *
 * Written once and run against both implementations — against Postgres in
 * `test/saga-store.db-spec.ts`, against the double in
 * `saga-store.contract.spec.ts`. The properties that matter are the ones about
 * *exclusion*: that a claim is atomic, that a second runner cannot take an
 * instance somebody already holds, and that a write from a runner whose lease
 * has moved on is refused. A double that got any of those wrong would make
 * every green e2e run meaningless, because the failure it hides only appears
 * with two replicas.
 */
export function describeSagaStoreContract(
  name: string,
  createHarness: () => Promise<SagaStoreHarness>,
): void {
  describe(`${name} (saga store contract)`, () => {
    let store: SagaStore;
    let other: SagaStore;
    let transactions: TransactionRunner;

    beforeEach(async () => {
      const harness = await createHarness();
      store = harness.store;
      other = harness.other.store;
      transactions = harness.transactions;
    });

    const create = (id = randomUUID()) =>
      transactions.run((tx) =>
        store.create(tx, {
          id,
          name: "order.checkout",
          state: { orderId: "order-1" },
          correlationId: "req-1",
        }),
      );

    const claim = (id: string, owner = "runner-a", now = new Date()) =>
      store.claim(id, { owner, now, leaseMs: MINUTE });

    describe("create()", () => {
      it("writes an instance that is running, at the first step, and due immediately", async () => {
        const created = await create();

        expect(created.status).toBe("RUNNING");
        expect(created.cursor).toBe(0);
        expect(created.attempts).toBe(0);
        expect(created.state).toEqual({ orderId: "order-1" });
        expect(created.log).toEqual([]);
        expect(created.lockedBy).toBeNull();
        expect(created.nextAttemptAt.getTime()).toBeLessThanOrEqual(Date.now() + 1_000);
      });

      it("keeps the correlation id the caller started it with", async () => {
        const created = await create();
        expect((await store.find(created.id))?.correlationId).toBe("req-1");
      });

      it("discards the instance when the unit of work fails", async () => {
        const id = randomUUID();
        await expect(
          transactions.run(async (tx) => {
            await store.create(tx, { id, name: "order.checkout", state: {}, correlationId: null });
            throw new Error("the order could not be written");
          }),
        ).rejects.toThrow("the order could not be written");

        // An instance without the order that caused it is a saga about nothing.
        expect(await store.find(id)).toBeNull();
      });
    });

    describe("find()", () => {
      it("resolves null for an id nobody wrote", async () => {
        expect(await store.find(randomUUID())).toBeNull();
      });
    });

    describe("claim()", () => {
      it("takes the lease and reports the instance", async () => {
        const created = await create();
        const claimed = await claim(created.id);

        expect(claimed?.id).toBe(created.id);
        expect(claimed?.lockedBy).toBe("runner-a");
        expect(claimed?.lockedUntil?.getTime()).toBeGreaterThan(Date.now());
      });

      it("refuses an instance somebody else holds", async () => {
        const created = await create();
        await claim(created.id, "runner-a");

        expect(
          await other.claim(created.id, { owner: "runner-b", now: new Date(), leaseMs: MINUTE }),
        ).toBeNull();
      });

      it("hands over an instance whose lease has expired", async () => {
        const created = await create();
        await claim(created.id, "runner-a");

        // The point of a lease: a runner that died holding one does not freeze
        // the saga forever.
        const later = new Date(Date.now() + 2 * MINUTE);
        const taken = await other.claim(created.id, {
          owner: "runner-b",
          now: later,
          leaseMs: MINUTE,
        });
        expect(taken?.lockedBy).toBe("runner-b");
      });

      it("refuses an instance that is not due yet", async () => {
        const created = await create();
        const claimed = await claim(created.id);
        await store.save(
          created.id,
          { owner: "runner-a", now: new Date(), leaseMs: MINUTE },
          progress({ nextAttemptAt: new Date(Date.now() + MINUTE), release: true }),
        );
        expect(claimed).not.toBeNull();

        expect(await claim(created.id, "runner-b")).toBeNull();
      });

      it("refuses a terminal instance", async () => {
        const created = await create();
        await claim(created.id);
        await store.save(
          created.id,
          { owner: "runner-a", now: new Date(), leaseMs: MINUTE },
          progress({ status: "COMPLETED", release: true }),
        );

        expect(await claim(created.id, "runner-b")).toBeNull();
      });

      it("resolves null for an instance that does not exist", async () => {
        expect(await claim(randomUUID())).toBeNull();
      });
    });

    describe("save()", () => {
      it("applies the whole advance and appends to the log", async () => {
        const created = await create();
        await claim(created.id);

        const saved = await store.save(
          created.id,
          { owner: "runner-a", now: new Date(), leaseMs: MINUTE },
          progress({ cursor: 2, attempts: 3, state: { orderId: "order-1", paymentId: "pay-1" } }),
        );

        expect(saved?.cursor).toBe(2);
        expect(saved?.attempts).toBe(3);
        expect(saved?.state).toEqual({ orderId: "order-1", paymentId: "pay-1" });
        expect(saved?.log).toHaveLength(1);
        expect(saved?.log[0]?.step).toBe("one");
      });

      it("appends rather than replaces, so the trail survives", async () => {
        const created = await create();
        await claim(created.id);
        const claimArgs = { owner: "runner-a", now: new Date(), leaseMs: MINUTE };

        await store.save(created.id, claimArgs, progress({ entry: entry("one") }));
        const saved = await store.save(created.id, claimArgs, progress({ entry: entry("two") }));

        expect(saved?.log.map((item) => item.step)).toEqual(["one", "two"]);
      });

      it("refuses a write from a runner that no longer holds the lease", async () => {
        const created = await create();
        await claim(created.id, "runner-a");
        // The lease expires and somebody else takes it, which is precisely when
        // the first runner's write must not land.
        await other.claim(created.id, {
          owner: "runner-b",
          now: new Date(Date.now() + 2 * MINUTE),
          leaseMs: MINUTE,
        });

        const refused = await store.save(
          created.id,
          { owner: "runner-a", now: new Date(), leaseMs: MINUTE },
          progress({ cursor: 9 }),
        );

        expect(refused).toBeNull();
        expect((await store.find(created.id))?.cursor).toBe(0);
      });

      it("drops the lease when the advance is over", async () => {
        const created = await create();
        await claim(created.id);

        const saved = await store.save(
          created.id,
          { owner: "runner-a", now: new Date(), leaseMs: MINUTE },
          progress({ status: "COMPLETED", release: true }),
        );

        expect(saved?.lockedBy).toBeNull();
        expect(saved?.lockedUntil).toBeNull();
      });

      it("extends the lease when the advance continues", async () => {
        const created = await create();
        const claimed = await claim(created.id, "runner-a");

        // Five seconds into the advance: the lease has to be pushed out from
        // *now* rather than from the claim, or a saga with several slow steps
        // would race its own expiry between them.
        const saved = await store.save(
          created.id,
          { owner: "runner-a", now: new Date(Date.now() + 5_000), leaseMs: MINUTE },
          progress({ release: false }),
        );

        expect(saved?.lockedBy).toBe("runner-a");
        expect(saved?.lockedUntil?.getTime()).toBeGreaterThan(claimed?.lockedUntil?.getTime() ?? 0);
      });
    });

    describe("claimDue()", () => {
      it("claims nothing, and reports so, when nothing is due", async () => {
        expect(
          await store.claimDue({ owner: "runner-a", now: new Date(), leaseMs: MINUTE }, 10),
        ).toEqual([]);
      });

      it("honours the batch size", async () => {
        await create();
        await create();
        await create();

        const claimed = await store.claimDue(
          { owner: "runner-a", now: new Date(), leaseMs: MINUTE },
          2,
        );
        expect(claimed).toHaveLength(2);
      });

      it("never hands the same instance to two pollers", async () => {
        const created = await create();

        const [first, second] = await Promise.all([
          store.claimDue({ owner: "runner-a", now: new Date(), leaseMs: MINUTE }, 10),
          other.claimDue({ owner: "runner-b", now: new Date(), leaseMs: MINUTE }, 10),
        ]);

        const claimedIds = [...first, ...second].map((instance) => instance.id);
        expect(claimedIds.filter((id) => id === created.id)).toHaveLength(1);
      });
    });

    describe("abandon()", () => {
      it("marks an instance stuck whether or not anybody holds its lease", async () => {
        const created = await create();
        await claim(created.id, "runner-a");

        await store.abandon(created.id, "STUCK", "its definition is gone");

        const abandoned = await store.find(created.id);
        expect(abandoned?.status).toBe("STUCK");
        expect(abandoned?.lastError).toBe("its definition is gone");
        expect(abandoned?.lockedBy).toBeNull();
      });
    });

    describe("countByStatus()", () => {
      it("reports every status, including the ones with nothing in them", async () => {
        await create();

        const counts = await store.countByStatus();

        expect(counts.RUNNING).toBe(1);
        expect(counts.STUCK).toBe(0);
        expect(Object.keys(counts).sort()).toEqual([
          "COMPENSATED",
          "COMPENSATING",
          "COMPLETED",
          "RUNNING",
          "STUCK",
        ]);
      });
    });
  });
}
