import { InMemoryAuditLogStore } from "@/test-utils/in-memory-audit-log.store";
import { InMemoryTransactionRunner } from "@/test-utils/in-memory-transaction.runner";
import { describeAuditLogStoreContract } from "./audit-log-store.contract";

/**
 * The contract against the in-memory double.
 *
 * `PrismaAuditLogStore` is held to the same contract by
 * `test/audit-log-store.db-spec.ts`, which needs a real Postgres: the
 * serialisation of two concurrent appends *is* `pg_advisory_xact_lock`, and the
 * refusal to modify an entry *is* a trigger. Neither can be stood in for — a
 * double reproducing them would be reimplementing the thing under test — so the
 * adapter's absence from this suite is deliberate.
 *
 * What this half is for is the e2e suite, which runs the whole application on
 * this double. Every property the contract asserts is one those specs would
 * otherwise be quietly relying on with nothing having checked it.
 */
describeAuditLogStoreContract("InMemoryAuditLogStore", () =>
  Promise.resolve({
    store: new InMemoryAuditLogStore(),
    transactions: new InMemoryTransactionRunner(),
  }),
);

describe("InMemoryAuditLogStore", () => {
  it("starts empty", async () => {
    const store = new InMemoryAuditLogStore();

    await expect(store.count()).resolves.toBe(0);
    await expect(store.head()).resolves.toBeNull();
  });

  it("reset() empties it, which the real table deliberately cannot do", async () => {
    const store = new InMemoryAuditLogStore();
    const transactions = new InMemoryTransactionRunner();
    await transactions.run((tx) =>
      store.append(tx, {
        action: "user.registered",
        resourceId: "usr-1",
        details: { email: "new@example.test", provider: null },
        actor: null,
        correlationId: null,
        occurredAt: new Date(0),
      }),
    );

    store.reset();

    await expect(store.count()).resolves.toBe(0);
    // And the chain restarts from the genesis entry, rather than remembering a
    // head nothing can now be verified against.
    const next = await transactions.run((tx) =>
      store.append(tx, {
        action: "user.registered",
        resourceId: "usr-2",
        details: { email: "next@example.test", provider: "google" },
        actor: null,
        correlationId: null,
        occurredAt: new Date(0),
      }),
    );
    expect(next.seq).toBe(1n);
  });
});
