import type { AuditEntry, NewAuditEntry } from "@/audit";
import { FIRST_SEQ, GENESIS_HASH, sealAuditEntry } from "@/audit";
import type { AuditLogPageRequest, AuditLogStore } from "@/audit";
import type { TransactionContext } from "@/common/prisma/transaction.port";

/**
 * An audit log in a `Map`, for the suites that run the whole application
 * without a database.
 *
 * It is a real implementation of the chain rather than a recorder: entries are
 * sealed through the same `sealAuditEntry` the Postgres adapter uses, so the
 * hashes an e2e test sees are the hashes production would write, and
 * `AuditChainVerifier` can be run against it unchanged.
 *
 * Two properties it cannot reproduce, and does not pretend to:
 *
 * - **Append-only.** Nothing stops a test reaching into `entries` and editing
 *   one — which is exactly what the tamper specs do, deliberately. In Postgres
 *   the same edit is refused by a trigger.
 * - **Serialisation under real concurrency.** Node runs one append at a time
 *   between awaits, so the tail cannot be read twice here however hard a test
 *   tries. `pg_advisory_xact_lock` is what provides this for real, and
 *   `test/audit-log-store.db-spec.ts` is where it is asserted.
 *
 * What it does honour is the transaction contract: an append registers a
 * rollback compensation, so an entry written inside a unit of work that then
 * fails disappears with it, as it would in the database.
 */
export class InMemoryAuditLogStore implements AuditLogStore {
  readonly entries: AuditEntry[] = [];

  async append(tx: TransactionContext, draft: NewAuditEntry): Promise<AuditEntry> {
    const tail = this.entries.at(-1) ?? null;
    const entry = sealAuditEntry(
      draft,
      tail ? tail.seq + 1n : FIRST_SEQ,
      tail ? tail.hash : GENESIS_HASH,
    );

    this.entries.push(entry);
    // Without this the double would keep entries the transaction abandoned, and
    // would then be the one participant in the unit of work that disagrees with
    // the database about what happened — which is the whole class of divergence
    // `onRollback` exists to remove.
    tx.onRollback(() => {
      const index = this.entries.indexOf(entry);
      if (index !== -1) this.entries.splice(index, 1);
    });

    return entry;
  }

  async head(): Promise<AuditEntry | null> {
    return this.entries.at(-1) ?? null;
  }

  async read({ afterSeq, limit }: AuditLogPageRequest): Promise<readonly AuditEntry[]> {
    return this.entries
      .filter((entry) => afterSeq === undefined || entry.seq > afterSeq)
      .slice(0, limit);
  }

  async count(): Promise<number> {
    return this.entries.length;
  }

  /** Empties the log between specs. The real table has no equivalent, by design. */
  reset(): void {
    this.entries.length = 0;
  }
}
