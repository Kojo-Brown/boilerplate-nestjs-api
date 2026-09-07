import { randomUUID } from "crypto";
import type { PrismaClient } from "@prisma/client";
import { PrismaTransactionRunner } from "@/common/prisma/prisma-transaction.runner";
import { PrismaSagaStore } from "@/saga";
import type { SagaStore } from "@/saga";
import { describeSagaStoreContract } from "@/saga/saga-store.contract";
import { asPrismaService, createClient } from "./helpers/db";

/**
 * `PrismaSagaStore` against a real Postgres.
 *
 * The same contract runs against the in-memory double in
 * `src/saga/saga-store.contract.spec.ts`. This is the half that matters for the
 * pattern, and for a sharper reason than the outbox's: the double's claim is
 * atomic because nothing in it awaits, which is a property of the event loop
 * and not of the code. Here it is a single `UPDATE … WHERE … RETURNING`, and
 * the difference between that and a read followed by a write is two replicas
 * running the same payment step at the same instant.
 *
 * No skip-if-absent branch, for the reason `test/outbox-store.db-spec.ts` gives:
 * a suite that passed without a database would be reporting that Postgres
 * behaves correctly while never having asked it.
 */
describe("PrismaSagaStore (Postgres)", () => {
  let client: PrismaClient;
  let other: PrismaClient;

  beforeAll(() => {
    client = createClient();
    // A second connection, so the two runners in the concurrency case are
    // genuinely concurrent rather than serialised by sharing one.
    other = createClient();
  });

  afterAll(async () => {
    await truncate(client);
    await client.$disconnect();
    await other.$disconnect();
  });

  describeSagaStoreContract("PrismaSagaStore", async () => {
    await truncate(client);
    return {
      store: new PrismaSagaStore(asPrismaService(client)),
      transactions: new PrismaTransactionRunner(asPrismaService(client)),
      other: { store: new PrismaSagaStore(asPrismaService(other)) },
    };
  });

  describe("the claim statements, against the real planner", () => {
    let store: SagaStore;
    let transactions: PrismaTransactionRunner;

    beforeEach(async () => {
      await truncate(client);
      store = new PrismaSagaStore(asPrismaService(client));
      transactions = new PrismaTransactionRunner(asPrismaService(client));
    });

    const create = (id = randomUUID()) =>
      transactions.run((tx) =>
        store.create(tx, {
          id,
          name: "order.checkout",
          state: { orderId: "order-1", paymentId: null },
          correlationId: null,
        }),
      );

    /**
     * The claim compares `status` against values cast to the enum type Prisma
     * generated. Get that name wrong and the statement fails at runtime with
     * `type "sagastatus" does not exist` — a class of bug no unit test can see,
     * because the double has no types at all.
     */
    it("claims a due instance through the enum cast", async () => {
      const created = await create();
      const claimed = await store.claim(created.id, {
        owner: "runner-a",
        now: new Date(),
        leaseMs: 60_000,
      });

      expect(claimed?.id).toBe(created.id);
      expect(claimed?.status).toBe("RUNNING");
    });

    it("round-trips the state and the log through jsonb", async () => {
      // `state` and `log` are written as bound parameters cast to `jsonb`, and
      // the log is appended with `||` in SQL rather than read-modify-written in
      // TypeScript. Neither is exercised by anything but a real server.
      const created = await create();
      const claim = { owner: "runner-a", now: new Date(), leaseMs: 60_000 };
      await store.claim(created.id, claim);

      const saved = await store.save(created.id, claim, {
        status: "RUNNING",
        cursor: 1,
        attempts: 0,
        nextAttemptAt: new Date(),
        state: { orderId: "order-1", paymentId: "pay_1", lines: [{ sku: "SKU-1", quantity: 2 }] },
        entry: {
          step: "accept-order",
          direction: "forward",
          outcome: "completed",
          attempt: 1,
          at: new Date().toISOString(),
        },
        lastError: null,
        release: false,
      });

      expect(saved?.state).toEqual({
        orderId: "order-1",
        paymentId: "pay_1",
        lines: [{ sku: "SKU-1", quantity: 2 }],
      });
      expect(saved?.log).toHaveLength(1);
      expect(saved?.log[0]?.step).toBe("accept-order");
    });

    it("never leases one instance to two concurrent pollers", async () => {
      // The property `SKIP LOCKED` inside the sub-select is there for, and the
      // one the double cannot evidence: two `UPDATE … WHERE id IN (SELECT …)`
      // statements running at the same instant on two connections.
      const created = await Promise.all([create(), create(), create()]);
      const otherStore = new PrismaSagaStore(asPrismaService(other));

      const [first, second] = await Promise.all([
        store.claimDue({ owner: "runner-a", now: new Date(), leaseMs: 60_000 }, 3),
        otherStore.claimDue({ owner: "runner-b", now: new Date(), leaseMs: 60_000 }, 3),
      ]);

      const ids = [...first, ...second].map((instance) => instance.id);
      expect(new Set(ids).size).toBe(ids.length);
      expect(ids.length).toBeLessThanOrEqual(created.length);
    });

    it("claims the instance that has been due longest, when it can only take one", async () => {
      const first = await create();
      // The claim's clock has to be taken *after* the row exists: an instance is
      // created due `now`, and a claim stamped a millisecond earlier is refused
      // for not being due yet.
      const claim = { owner: "runner-a", now: new Date(), leaseMs: 60_000 };
      expect(await store.claim(first.id, claim)).not.toBeNull();
      // Push it out into the future, so the second one created is the one due
      // soonest — otherwise this asserts on insertion order rather than on the
      // `ORDER BY`.
      await store.save(first.id, claim, {
        status: "RUNNING",
        cursor: 0,
        attempts: 1,
        nextAttemptAt: new Date(Date.now() + 30_000),
        state: {},
        entry: {
          step: "accept-order",
          direction: "forward",
          outcome: "failed",
          attempt: 1,
          at: new Date().toISOString(),
        },
        lastError: "not yet",
        release: true,
      });
      const second = await create();

      // Limit of one, because what the `ORDER BY` decides is *which* rows are
      // claimed. It says nothing about the order `RETURNING` hands them back
      // in, and asserting on that would be asserting on an implementation
      // detail of the planner.
      const claimed = await store.claimDue(
        { owner: "runner-b", now: new Date(Date.now() + 60_000), leaseMs: 60_000 },
        1,
      );

      expect(claimed.map((instance) => instance.id)).toEqual([second.id]);
    });
  });
});

/** Sagas hold no foreign keys, so the order only matters for the orders table. */
async function truncate(client: PrismaClient): Promise<void> {
  await client.order.deleteMany({});
  await client.sagaInstance.deleteMany({});
}
