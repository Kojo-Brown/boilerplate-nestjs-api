import { InMemoryAuditLogStore } from "@/test-utils/in-memory-audit-log.store";
import { InMemoryTransactionRunner } from "@/test-utils/in-memory-transaction.runner";
import type { TransactionContext } from "@/common/prisma/transaction.port";
import { AuditLog } from "./audit-log.service";
import { GENESIS_HASH } from "./audit-hash";
import type { AuditLogStore } from "./ports";

describe("AuditLog", () => {
  let store: InMemoryAuditLogStore;
  let transactions: InMemoryTransactionRunner;
  let audit: AuditLog;

  beforeEach(() => {
    store = new InMemoryAuditLogStore();
    transactions = new InMemoryTransactionRunner();
    audit = new AuditLog(store);
  });

  it("appends inside the caller's transaction and returns the sealed entry", async () => {
    const entry = await transactions.run((tx) =>
      audit.record(
        tx,
        "user.deleted",
        "usr-1",
        { email: "gone@example.test" },
        { actor: { id: "adm-1", role: "ADMIN" }, correlationId: "corr-1" },
      ),
    );

    expect(entry).toMatchObject({
      seq: 1n,
      action: "user.deleted",
      resourceType: "user",
      resourceId: "usr-1",
      details: { email: "gone@example.test" },
      actorId: "adm-1",
      actorRole: "ADMIN",
      correlationId: "corr-1",
      prevHash: GENESIS_HASH,
    });
    expect(store.entries).toEqual([entry]);
  });

  it("records the system as the actor when the caller names nobody", async () => {
    const entry = await transactions.run((tx) =>
      audit.record(tx, "user.deleted", "usr-1", { email: "gone@example.test" }),
    );

    expect([entry.actorId, entry.actorRole, entry.correlationId]).toEqual([null, null, null]);
  });

  it("stamps occurredAt itself, inside the transaction", async () => {
    const before = Date.now();
    const entry = await transactions.run((tx) =>
      audit.record(tx, "user.deleted", "usr-1", { email: "gone@example.test" }),
    );

    // There is no database-assigned timestamp to fall back on: a column outside
    // the preimage would be one an attacker could rewrite freely.
    expect(entry.occurredAt.getTime()).toBeGreaterThanOrEqual(before);
    expect(entry.occurredAt.getTime()).toBeLessThanOrEqual(Date.now());
  });

  it("writes nothing when the caller's unit of work fails", async () => {
    const failure = new Error("the audited operation failed");

    await expect(
      transactions.run(async (tx) => {
        await audit.record(tx, "user.deleted", "usr-1", { email: "gone@example.test" });
        throw failure;
      }),
    ).rejects.toBe(failure);

    expect(store.entries).toEqual([]);
  });

  it("hands the store the caller's transaction, never one of its own", async () => {
    // The property that makes this an audit log rather than a second thing that
    // can fail on its own. A service that opened its own unit of work would
    // commit a record of an operation that went on to roll back.
    const spy: AuditLogStore = {
      append: jest.fn(store.append.bind(store)),
      head: store.head.bind(store),
      read: store.read.bind(store),
      count: store.count.bind(store),
    };
    let opened: TransactionContext | undefined;

    await transactions.run((tx) => {
      opened = tx;
      return new AuditLog(spy).record(tx, "user.deleted", "usr-1", {
        email: "gone@example.test",
      });
    });

    expect(spy.append).toHaveBeenCalledWith(
      opened,
      expect.objectContaining({ action: "user.deleted" }),
    );
  });
});
