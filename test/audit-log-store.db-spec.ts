import { Prisma, type PrismaClient } from "@prisma/client";
import {
  AUDIT_LOG_LOCK_CLASS,
  AUDIT_LOG_LOCK_OBJECT,
  AuditChainVerifier,
  auditEntryHash,
  GENESIS_HASH,
  isAppendOnlyViolation,
  PrismaAuditLogStore,
} from "@/audit";
import type { NewAuditEntry } from "@/audit";
import { describeAuditLogStoreContract } from "@/audit/audit-log-store.contract";
import { PrismaTransactionRunner } from "@/common/prisma/prisma-transaction.runner";
import { asPrismaService, createClient, truncateAll, uniqueEmail } from "./helpers/db";

/**
 * `PrismaAuditLogStore` against a real Postgres.
 *
 * The same contract runs against the in-memory double in
 * `src/audit/audit-log-store.contract.spec.ts`. This is the half that matters
 * for tamper-evidence, because the two properties that make this a ledger are
 * not in the TypeScript at all:
 *
 * - **Append-only** is a trigger. Nothing in the application enforces it, and
 *   nothing in the application could: the point is that a `DELETE` issued from
 *   anywhere — psql, a migration, a compromised role — is refused.
 * - **A total order** is `pg_advisory_xact_lock`. Node runs one append at a
 *   time between awaits, so the in-memory double cannot fail this test however
 *   hard it tries; two real connections racing for the tail can.
 *
 * Neither can be stood in for, so this suite has no skip-if-absent branch. A
 * suite that passed without a database would be reporting that Postgres behaves
 * correctly while never having asked it.
 */
describe("PrismaAuditLogStore (Postgres)", () => {
  let client: PrismaClient;
  let other: PrismaClient;

  beforeAll(() => {
    client = createClient();
    // A second connection, so the two appends in the concurrency case are
    // genuinely concurrent rather than serialised by sharing one.
    other = createClient();
  });

  afterAll(async () => {
    await truncate(client);
    await client.$disconnect();
    await other.$disconnect();
  });

  describeAuditLogStoreContract("PrismaAuditLogStore", async () => {
    await truncate(client);
    return {
      store: new PrismaAuditLogStore(asPrismaService(client)),
      transactions: new PrismaTransactionRunner(asPrismaService(client)),
    };
  });

  describe("the append-only triggers", () => {
    let store: PrismaAuditLogStore;
    let transactions: PrismaTransactionRunner;

    beforeEach(async () => {
      await truncate(client);
      store = new PrismaAuditLogStore(asPrismaService(client));
      transactions = new PrismaTransactionRunner(asPrismaService(client));
      await transactions.run((tx) => store.append(tx, draft("usr-trigger")));
    });

    it("refuses an UPDATE, whatever issues it", async () => {
      // Through Prisma's own model API, which is how an accidental rewrite
      // would actually arrive: a `prisma.auditLogEntry.update` somebody added
      // to "correct" an entry.
      await expect(
        client.auditLogEntry.update({ where: { seq: 1n }, data: { action: "user.registered" } }),
      ).rejects.toThrow(/append-only/);

      await expect(
        client.$executeRaw`UPDATE audit_log SET "resourceId" = 'rewritten' WHERE seq = 1`,
      ).rejects.toThrow(/append-only/);
    });

    it("refuses a DELETE", async () => {
      await expect(client.auditLogEntry.delete({ where: { seq: 1n } })).rejects.toThrow(
        /append-only/,
      );
      await expect(client.auditLogEntry.deleteMany({})).rejects.toThrow(/append-only/);
    });

    it("refuses a TRUNCATE, which fires no row-level trigger of its own", async () => {
      // The statement somebody reaching for a clean slate would use, and the
      // one a `FOR EACH ROW` trigger alone would not see.
      await expect(client.$executeRawUnsafe(`TRUNCATE TABLE audit_log`)).rejects.toThrow(
        /append-only/,
      );
    });

    it("raises its own SQLSTATE, so a caller need not match on English", async () => {
      const failure = await client.auditLogEntry
        .delete({ where: { seq: 1n } })
        .then(() => null)
        .catch((error: unknown) => error);

      // This is the spec that pins where Prisma puts a driver-level SQLSTATE.
      // The client reports `P2039` — "driver adapter error" — and buries the
      // real code at `meta.driverAdapterError.cause.code`, a path that is in
      // none of its public types. `isAppendOnlyViolation` walks it, and only a
      // real server can tell us it still leads somewhere.
      expect(failure).toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
      expect((failure as Prisma.PrismaClientKnownRequestError).code).toBe("P2039");
      expect(isAppendOnlyViolation(failure)).toBe(true);
    });

    it("does not mistake an unrelated failure for the append-only refusal", async () => {
      const duplicate = await client.auditLogEntry
        .create({
          data: {
            seq: 1n,
            occurredAt: new Date(),
            action: "user.deleted",
            resourceType: "user",
            resourceId: "usr-dup",
            details: {},
            prevHash: GENESIS_HASH,
            hash: "f".repeat(64),
          },
        })
        .then(() => null)
        .catch((error: unknown) => error);

      expect(duplicate).toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
      expect(isAppendOnlyViolation(duplicate)).toBe(false);
    });

    it("leaves the entry exactly as it was written", async () => {
      await expect(client.auditLogEntry.count()).resolves.toBe(1);
      const row = await client.auditLogEntry.findUniqueOrThrow({ where: { seq: 1n } });
      expect(row.resourceId).toBe("usr-trigger");
    });
  });

  describe("the chain, under real concurrency", () => {
    let store: PrismaAuditLogStore;
    let otherStore: PrismaAuditLogStore;
    let transactions: PrismaTransactionRunner;
    let otherTransactions: PrismaTransactionRunner;

    beforeEach(async () => {
      await truncate(client);
      store = new PrismaAuditLogStore(asPrismaService(client));
      otherStore = new PrismaAuditLogStore(asPrismaService(other));
      transactions = new PrismaTransactionRunner(asPrismaService(client));
      otherTransactions = new PrismaTransactionRunner(asPrismaService(other));
    });

    /**
     * The property the whole chain rests on, and the one only a real server can
     * show.
     *
     * Two transactions on two connections append at the same time. Without the
     * advisory lock both read an empty table, both decide they are entry 1
     * anchored on the genesis hash, and one of them loses the primary-key race
     * — or, on a non-empty table, both chain onto the same tail and the chain
     * forks. With it, the second is admitted only once the first has committed.
     */
    it("serialises two concurrent appends into one unbroken chain", async () => {
      const [first, second] = await Promise.all([
        transactions.run((tx) => store.append(tx, draft("usr-a"))),
        otherTransactions.run((tx) => otherStore.append(tx, draft("usr-b"))),
      ]);

      const bySeq = [first, second].sort((a, b) => Number(a.seq - b.seq));
      expect(bySeq.map((entry) => entry.seq)).toEqual([1n, 2n]);
      expect(bySeq[0]!.prevHash).toBe(GENESIS_HASH);
      expect(bySeq[1]!.prevHash).toBe(bySeq[0]!.hash);
    });

    it("holds the lock until the caller's transaction ends, not until the insert returns", async () => {
      // A lock released at the end of the `append` call would let the second
      // transaction read the tail before the first committed. Postgres releases
      // an `xact` advisory lock only at commit or rollback, which is what makes
      // the second appender wait for a tail that is actually there.
      let firstCommitted = false;

      const slow = transactions.run(async (tx) => {
        const entry = await store.append(tx, draft("usr-slow"));
        await new Promise((resolve) => setTimeout(resolve, 150));
        firstCommitted = true;
        return entry;
      });
      // Started after the first has had time to take the lock, so the ordering
      // under test is the lock rather than the scheduler.
      await new Promise((resolve) => setTimeout(resolve, 50));
      const fast = otherTransactions.run((tx) => otherStore.append(tx, draft("usr-fast")));

      const [slowEntry, fastEntry] = await Promise.all([slow, fast]);

      expect(firstCommitted).toBe(true);
      expect(slowEntry.seq).toBe(1n);
      expect(fastEntry.seq).toBe(2n);
      expect(fastEntry.prevHash).toBe(slowEntry.hash);
    });

    it("gives a rolled-back append's number to the next one", async () => {
      await transactions.run((tx) => store.append(tx, draft("usr-1")));

      await expect(
        transactions.run(async (tx) => {
          await store.append(tx, draft("usr-doomed"));
          throw new Error("the audited operation failed");
        }),
      ).rejects.toThrow("the audited operation failed");

      // Postgres — not any code in this repository — is what makes the entry
      // never have existed, and the number it took available again. A sequence
      // default would have left a permanent gap here, and a gap is exactly what
      // a deleted entry looks like.
      const next = await transactions.run((tx) => store.append(tx, draft("usr-2")));
      expect(next.seq).toBe(2n);
      await expect(client.auditLogEntry.count()).resolves.toBe(2);
    });

    it("names the lock it waits on, so a blocked append is diagnosable", async () => {
      // Not an assertion about behaviour but about operability: the two halves
      // of the key are what an operator reading `pg_locks` has to go on.
      await transactions.run(async (tx) => {
        await store.append(tx, draft("usr-lock"));
        const held = await client.$queryRaw<{ classid: number; objid: number }[]>`
          SELECT classid, objid FROM pg_locks
          WHERE locktype = 'advisory' AND classid = ${AUDIT_LOG_LOCK_CLASS}
            AND objid = ${AUDIT_LOG_LOCK_OBJECT} AND granted`;
        expect(held).toHaveLength(1);
      });
    });

    it("commits the entry with the row it describes", async () => {
      const email = uniqueEmail("audit-atomic");

      await transactions.run(async (tx) => {
        const created = await requireClient(tx).user.create({ data: { email } });
        await store.append(tx, { ...draft(created.id), details: { email } });
      });

      const [users, entries] = await Promise.all([
        client.user.count({ where: { email } }),
        client.auditLogEntry.count(),
      ]);
      // A user deleted with no record of who did it — or a record of a deletion
      // that rolled back — is what a write after the commit can produce and this
      // cannot.
      expect([users, entries]).toEqual([1, 1]);
    });
  });

  describe("the verifier, against a chain tampered with past the triggers", () => {
    let store: PrismaAuditLogStore;
    let transactions: PrismaTransactionRunner;
    let verifier: AuditChainVerifier;

    beforeEach(async () => {
      await truncate(client);
      store = new PrismaAuditLogStore(asPrismaService(client));
      transactions = new PrismaTransactionRunner(asPrismaService(client));
      verifier = new AuditChainVerifier(store);
      for (const id of ["usr-1", "usr-2", "usr-3"]) {
        await transactions.run((tx) => store.append(tx, draft(id)));
      }
    });

    it("verifies what the adapter wrote, hashes and all", async () => {
      const head = await store.head();

      await expect(verifier.verify()).resolves.toMatchObject({
        intact: true,
        checked: 3,
        firstSeq: 1n,
        lastSeq: 3n,
        headHash: head!.hash,
      });
    });

    /**
     * The scenario the chain exists for, performed for real.
     *
     * The triggers stop the application, an ORM typo and casual SQL. They do
     * not stop the table's *owner*, who can switch them off — so that is
     * exactly what this does. It is the honest statement of where each layer
     * ends: the trigger is the control, and the chain is the evidence that
     * still works once somebody with `ALTER TABLE` is in play.
     */
    it("catches an entry edited with the triggers disabled", async () => {
      await withTriggersDisabled(client, async () => {
        await client.$executeRaw`UPDATE audit_log SET "resourceId" = 'rewritten' WHERE seq = 2`;
      });

      const report = await verifier.verify();

      expect(report.intact).toBe(false);
      expect(report.breach).toMatchObject({ seq: 2n, kind: "forged-hash" });
    });

    it("catches an edit that was re-hashed to cover its tracks", async () => {
      const row = await client.auditLogEntry.findUniqueOrThrow({ where: { seq: 2n } });
      const forged = { ...row, resourceId: "rewritten", details: row.details as unknown };

      await withTriggersDisabled(client, async () => {
        await client.$executeRaw`
          UPDATE audit_log SET "resourceId" = 'rewritten', hash = ${auditEntryHash(forged)}
          WHERE seq = 2`;
      });

      const report = await verifier.verify();

      // Entry 2 now hashes to itself perfectly. Entry 3 still names the hash it
      // used to have, so covering one row means rewriting every row after it.
      expect(report.breach).toMatchObject({ seq: 3n, kind: "broken-link" });
    });

    it("catches a deleted entry, which no hash check could", async () => {
      await withTriggersDisabled(client, async () => {
        await client.$executeRaw`DELETE FROM audit_log WHERE seq = 2`;
      });

      const report = await verifier.verify();

      // 1 and 3 both hash perfectly and nothing links them. Only the missing
      // number gives it away — which is why `seq` is assigned under a lock
      // rather than by a sequence that leaves innocent gaps of its own.
      expect(report.breach).toMatchObject({ seq: 2n, kind: "gap" });
    });

    it("is intact again once the triggers are back on and nothing was touched", async () => {
      await withTriggersDisabled(client, async () => {
        /* deliberately nothing: disabling the triggers is not itself a breach */
      });

      await expect(verifier.verify()).resolves.toMatchObject({ intact: true, checked: 3 });
      // And the table is protected again, so the helper cannot leave the suite
      // in a state where a later spec silently writes past the control.
      await expect(client.auditLogEntry.deleteMany({})).rejects.toThrow(/append-only/);
    });
  });
});

let sequence = 0;

function draft(resourceId: string): NewAuditEntry<"user.deleted"> {
  sequence += 1;
  return {
    action: "user.deleted",
    resourceId,
    details: { email: `db-spec-${sequence}@example.test` },
    actor: { id: "adm-1", role: "ADMIN" },
    correlationId: `corr-${sequence}`,
    occurredAt: new Date(Date.UTC(2026, 8, 16, 12, 0, 0, sequence % 1000)),
  };
}

/**
 * Runs `work` with the append-only triggers off, and puts them back afterwards.
 *
 * This is the only way to write the tamper cases at all — which is the point
 * being made rather than a workaround. `ALTER TABLE … DISABLE TRIGGER USER`
 * requires ownership of the table, so it is available to a DBA and to nobody
 * the application authenticates as.
 *
 * `finally`, so a failing assertion cannot leave the table unprotected for the
 * specs that follow.
 */
async function withTriggersDisabled(
  client: PrismaClient,
  work: () => Promise<void>,
): Promise<void> {
  await client.$executeRawUnsafe(`ALTER TABLE audit_log DISABLE TRIGGER USER`);
  try {
    await work();
  } finally {
    await client.$executeRawUnsafe(`ALTER TABLE audit_log ENABLE TRIGGER USER`);
  }
}

/** `truncateAll` predates the audit table, and this one cannot be deleted from normally. */
async function truncate(client: PrismaClient): Promise<void> {
  await withTriggersDisabled(client, async () => {
    await client.$executeRawUnsafe(`DELETE FROM audit_log`);
  });
  await truncateAll(client);
}

/**
 * The transaction client inside an opaque handle.
 *
 * Only this suite needs it: it writes a `users` row and an audit entry through
 * the same handle to prove they share a transaction, and production code always
 * goes through an adapter that narrows the handle for itself.
 */
function requireClient(tx: { backend: string }): PrismaClient {
  return (tx as unknown as { client: PrismaClient }).client;
}
