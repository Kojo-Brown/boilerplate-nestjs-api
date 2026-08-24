import type { PrismaClient } from "@prisma/client";
import { PrismaOutboxStore } from "@/outbox";
import type { OutboxStore } from "@/outbox";
import { describeOutboxStoreContract } from "@/outbox/outbox-store.contract";
import { PrismaTransactionRunner } from "@/common/prisma/prisma-transaction.runner";
import { asPrismaService, createClient, truncateAll, uniqueEmail } from "./helpers/db";

/**
 * `PrismaOutboxStore` against a real Postgres.
 *
 * The same contract runs against the in-memory double in
 * `src/outbox/outbox-store.contract.spec.ts`. This is the half that matters for
 * the pattern: the atomicity a staged event depends on *is* the transaction it
 * was written in, and the exclusion between two relays *is* `FOR UPDATE SKIP
 * LOCKED`. Neither can be stood in for — a double reproducing them would be
 * reimplementing the thing under test — so this suite has no skip-if-absent
 * branch. A suite that passed without a database would be reporting that
 * Postgres behaves correctly while never having asked it.
 */
describe("PrismaOutboxStore (Postgres)", () => {
  let client: PrismaClient;
  let other: PrismaClient;

  beforeAll(() => {
    client = createClient();
    // A second connection, so the two relays in the concurrency case are
    // genuinely concurrent rather than serialised by sharing one.
    other = createClient();
  });

  afterAll(async () => {
    await truncate(client);
    await client.$disconnect();
    await other.$disconnect();
  });

  describeOutboxStoreContract("PrismaOutboxStore", async () => {
    await truncate(client);
    return {
      store: new PrismaOutboxStore(asPrismaService(client)),
      transactions: new PrismaTransactionRunner(asPrismaService(client)),
      other: { store: new PrismaOutboxStore(asPrismaService(other)) },
    };
  });

  describe("the claim query, against the real planner", () => {
    let store: OutboxStore;
    let transactions: PrismaTransactionRunner;

    beforeEach(async () => {
      await truncate(client);
      store = new PrismaOutboxStore(asPrismaService(client));
      transactions = new PrismaTransactionRunner(asPrismaService(client));
    });

    const stage = async (eventId: string, occurredAt = new Date(Date.now() - 60_000)) => {
      await transactions.run((tx) =>
        store.stage(tx, {
          eventId,
          name: "user.registered",
          payload: { userId: "user-1", email: uniqueEmail("outbox"), name: null, provider: null },
          correlationId: null,
          occurredAt,
        }),
      );
    };

    /**
     * The claim compares `status` against a value cast to the enum type Prisma
     * generated. Get that name wrong and the statement fails at runtime with
     * `42704 type "…" does not exist`, which nothing but a real server reports —
     * the raw SQL is invisible to `tsc` and to every in-memory double.
     */
    it("runs at all, which is the only thing that checks the enum cast", async () => {
      await stage("evt-enum");

      const report = await store.drain({
        now: new Date(),
        batchSize: 10,
        deliver: () => Promise.resolve(),
        retryAt: () => null,
      });

      expect(report.claimed).toBe(1);
    });

    /**
     * The write the whole pattern rests on.
     *
     * Not the double's `onRollback` compensation this time: the row is inserted
     * on a real connection inside a real transaction, the transaction aborts,
     * and Postgres — not any code in this repository — is what makes the event
     * never have existed.
     */
    it("loses a staged event to a real ROLLBACK", async () => {
      await expect(
        transactions.run(async (tx) => {
          await store.stage(tx, {
            eventId: "evt-rolled-back",
            name: "user.registered",
            payload: { userId: "u", email: uniqueEmail("rollback"), name: null, provider: null },
            correlationId: null,
            occurredAt: new Date(),
          });
          throw new Error("the operation failed after staging");
        }),
      ).rejects.toThrow("the operation failed after staging");

      await expect(client.outboxEvent.count()).resolves.toBe(0);
    });

    /**
     * The other half of the same property: a commit carries both writes.
     *
     * Staged alongside a `users` insert, on one connection, in one transaction.
     * A user that exists without its event — or an event without its user — is
     * what an emitter after the write can produce and this cannot.
     */
    it("commits the event with the row it describes", async () => {
      const email = uniqueEmail("outbox-atomic");

      await transactions.run(async (tx) => {
        const created = await requireClient(tx).user.create({ data: { email } });
        await store.stage(tx, {
          eventId: "evt-atomic",
          name: "user.registered",
          payload: { userId: created.id, email, name: null, provider: null },
          correlationId: null,
          occurredAt: new Date(),
        });
      });

      const [users, events] = await Promise.all([
        client.user.count({ where: { email } }),
        client.outboxEvent.count({ where: { eventId: "evt-atomic" } }),
      ]);
      expect([users, events]).toEqual([1, 1]);
    });

    it("rolls the row back with the event when the unit of work fails", async () => {
      const email = uniqueEmail("outbox-atomic-fail");

      await expect(
        transactions.run(async (tx) => {
          await requireClient(tx).user.create({ data: { email } });
          await store.stage(tx, {
            eventId: "evt-atomic-fail",
            name: "user.registered",
            payload: { userId: "u", email, name: null, provider: null },
            correlationId: null,
            occurredAt: new Date(),
          });
          throw new Error("something later went wrong");
        }),
      ).rejects.toThrow("something later went wrong");

      const [users, events] = await Promise.all([
        client.user.count({ where: { email } }),
        client.outboxEvent.count({ where: { eventId: "evt-atomic-fail" } }),
      ]);
      expect([users, events]).toEqual([0, 0]);
    });

    /**
     * `SKIP LOCKED`, not merely `FOR UPDATE`.
     *
     * With `FOR UPDATE` alone the second relay would *block* on the first one's
     * batch for the whole of its broker round trip, so scaling out would buy
     * nothing. This asserts the second relay makes progress on other rows while
     * the first is still holding its claim.
     */
    it("lets a second relay work while the first one holds its batch", async () => {
      await stage("evt-a", new Date(Date.now() - 120_000));
      await stage("evt-b", new Date(Date.now() - 60_000));

      let firstEntered: () => void = () => {};
      const entered = new Promise<void>((resolve) => {
        firstEntered = resolve;
      });
      let release: () => void = () => {};
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });

      const seenByFirst: string[] = [];
      const first = store.drain({
        now: new Date(),
        batchSize: 1,
        deliver: async (record) => {
          seenByFirst.push(record.eventId);
          firstEntered();
          await held;
        },
        retryAt: () => null,
      });

      await entered;
      const seenBySecond: string[] = [];
      const secondReport = await new PrismaOutboxStore(asPrismaService(other)).drain({
        now: new Date(),
        batchSize: 10,
        deliver: (record) => {
          seenBySecond.push(record.eventId);
          return Promise.resolve();
        },
        retryAt: () => null,
      });
      release();
      await first;

      expect(seenByFirst).toEqual(["evt-a"]);
      // It did not block, and it did not take the row the first relay holds.
      expect(secondReport.claimed).toBe(1);
      expect(seenBySecond).toEqual(["evt-b"]);
    });

    it("dead-letters a row naming an event this build does not know", async () => {
      // Written straight to the table: `stage` cannot produce this, which is
      // the point — only a build that knew the event could have, and it is gone.
      await client.$executeRawUnsafe(
        `INSERT INTO "outbox_events" ("id", "eventId", "name", "payload", "occurredAt", "updatedAt")
         VALUES ('row-retired', 'evt-retired', 'user.retired', '{}'::jsonb, now(), now())`,
      );

      const deliver = jest.fn();
      const report = await store.drain({
        now: new Date(),
        batchSize: 10,
        deliver,
        retryAt: () => new Date(Date.now() + 60_000),
      });

      expect(deliver).not.toHaveBeenCalled();
      expect(report.outcomes).toEqual([
        expect.objectContaining({
          disposition: "dead",
          error: expect.stringContaining("not in DomainEventPayloads"),
        }),
      ]);
    });

    it("truncates a very long failure rather than storing a whole stack trace", async () => {
      await stage("evt-long-error");

      await store.drain({
        now: new Date(),
        batchSize: 10,
        deliver: () => Promise.reject(new Error("x".repeat(5_000))),
        retryAt: () => new Date(Date.now() + 60_000),
      });

      const row = await client.outboxEvent.findUniqueOrThrow({
        where: { eventId: "evt-long-error" },
      });
      expect(row.lastError?.length).toBe(500);
      expect(row.lastError?.endsWith("…")).toBe(true);
    });
  });
});

/** `truncateAll` predates the outbox table; this clears that too. */
async function truncate(client: PrismaClient): Promise<void> {
  await client.outboxEvent.deleteMany({});
  await truncateAll(client);
}

/**
 * The transaction client inside an opaque handle.
 *
 * Only this suite needs it: it writes a `users` row and an outbox row through
 * the same handle to prove they share a transaction, and production code always
 * goes through an adapter that narrows the handle for itself.
 */
function requireClient(tx: { backend: string }): PrismaClient {
  return (tx as unknown as { client: PrismaClient }).client;
}
