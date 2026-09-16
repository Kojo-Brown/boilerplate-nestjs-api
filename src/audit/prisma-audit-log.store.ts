import { Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "@/common/prisma/prisma.service";
import { requirePrismaTransaction } from "@/common/prisma/prisma-transaction.runner";
import type { TransactionContext } from "@/common/prisma/transaction.port";
import type { AuditEntry, NewAuditEntry } from "./audit-entry";
import { FIRST_SEQ, GENESIS_HASH, sealAuditEntry } from "./audit-hash";
import type { AuditLogPageRequest, AuditLogStore } from "./ports";

/**
 * The advisory-lock key the chain serialises on.
 *
 * `pg_advisory_xact_lock` takes either one `bigint` or two `int4`s; the pair is
 * used here because the two halves show up as separate columns in `pg_locks`,
 * so an operator looking at a blocked backend can tell what it is waiting for.
 * The values spell `AU` and `LG` as big-endian 16-bit pairs — arbitrary, but
 * legible in the one place anybody will ever read them.
 *
 * `docs/pessimistic-locking.md` named this case before there was anything in it:
 * an advisory lock is what you want when the thing being protected has no row
 * to lock. The end of a chain is exactly that — on an empty table there is no
 * tail row to take a lock on, and that is precisely the moment two concurrent
 * appends would both decide they are the genesis entry.
 */
export const AUDIT_LOG_LOCK_CLASS = 0x4155;
export const AUDIT_LOG_LOCK_OBJECT = 0x4c47;

/** One row, as Prisma returns it. `seq` comes back as a JS `bigint`. */
type AuditLogRow = Prisma.AuditLogEntryGetPayload<Record<string, never>>;

/**
 * The Postgres-backed audit log.
 *
 * Two things make this a ledger rather than a table with a hash column, and
 * neither is in the TypeScript:
 *
 * 1. the append-only triggers in `20260916000000_add_audit_log`, which refuse
 *    `UPDATE`, `DELETE` and `TRUNCATE` on the table outright; and
 * 2. `pg_advisory_xact_lock`, which is what makes `seq` a real order rather
 *    than a number two writers raced for.
 *
 * The lock is the part worth being precise about. It is taken *inside* the
 * caller's transaction and released when that transaction ends — commit or
 * rollback, by the server, with nothing to expire and no clock to be right
 * about. So the sequence of events for two concurrent appends is: A takes the
 * lock, reads tail `n`, writes `n+1`; B blocks; A commits; B is admitted, reads
 * tail `n+1`, writes `n+2`. If A rolls back instead, its row goes with it and B
 * reads tail `n` and writes `n+1` — no gap, no fork, no wasted number.
 *
 * What it costs is honest and worth stating: appends are serialised globally,
 * and the lock is held from the append to the caller's commit. A transaction
 * that audits early and then does something slow holds up every other audited
 * write for that long, which is why `AuditLog.record` is documented as the last
 * thing a unit of work should do. The throughput ceiling this implies — one
 * audited transaction at a time — is the price of a single linear chain, and
 * `docs/audit-log.md` says what buying it back would look like.
 */
@Injectable()
export class PrismaAuditLogStore implements AuditLogStore {
  constructor(private readonly prisma: PrismaService) {}

  async append(tx: TransactionContext, draft: NewAuditEntry): Promise<AuditEntry> {
    const client = requirePrismaTransaction(tx, PrismaAuditLogStore.name);

    // Before the tail is read, not after: a lock taken afterwards would be
    // protecting a value that was already stale when it was read.
    //
    // `$executeRaw` rather than `$queryRaw`, although this is a `SELECT`.
    // `pg_advisory_xact_lock` returns `void`, and Prisma's deserialiser has no
    // mapping for that type — `$queryRaw` fails with "Failed to deserialize
    // column of type 'void'" before the lock is of any use to anyone.
    // `$executeRaw` does not read the result set, which is all this needs.
    await client.$executeRaw`SELECT pg_advisory_xact_lock(${AUDIT_LOG_LOCK_CLASS}, ${AUDIT_LOG_LOCK_OBJECT})`;

    // Read through the transaction client, so it sees this transaction's own
    // earlier appends. A unit of work that records two actions must chain the
    // second onto the first, and the top-level client — READ COMMITTED, outside
    // the transaction — would not see the first one at all.
    const tail = await client.auditLogEntry.findFirst({ orderBy: { seq: "desc" } });

    const entry = sealAuditEntry(
      draft,
      tail ? tail.seq + 1n : FIRST_SEQ,
      tail ? tail.hash : GENESIS_HASH,
    );

    await client.auditLogEntry.create({
      data: {
        seq: entry.seq,
        occurredAt: entry.occurredAt,
        action: entry.action,
        resourceType: entry.resourceType,
        resourceId: entry.resourceId,
        // `sealAuditEntry` has already put this value through `canonicalJson`,
        // which throws on anything JSON cannot represent — so by here it is
        // known to be JSON-shaped. Prisma's `InputJsonValue` cannot be inferred
        // from `unknown`, which is all the cast is for.
        details: entry.details as Prisma.InputJsonValue,
        actorId: entry.actorId,
        actorRole: entry.actorRole,
        correlationId: entry.correlationId,
        prevHash: entry.prevHash,
        hash: entry.hash,
      },
    });

    return entry;
  }

  async head(): Promise<AuditEntry | null> {
    const row = await this.prisma.auditLogEntry.findFirst({ orderBy: { seq: "desc" } });
    return row ? toEntry(row) : null;
  }

  async read({ afterSeq, limit }: AuditLogPageRequest): Promise<readonly AuditEntry[]> {
    const rows = await this.prisma.auditLogEntry.findMany({
      where: afterSeq === undefined ? undefined : { seq: { gt: afterSeq } },
      orderBy: { seq: "asc" },
      take: limit,
    });
    return rows.map(toEntry);
  }

  async count(): Promise<number> {
    return this.prisma.auditLogEntry.count();
  }
}

/**
 * A row as the port describes it.
 *
 * `details` is `Prisma.JsonValue` on the way out and `unknown` on the port,
 * which is a widening rather than a cast: the verifier re-encodes whatever it
 * finds, and an entry written by a build that has since retired its action must
 * still be readable and checkable.
 */
function toEntry(row: AuditLogRow): AuditEntry {
  return {
    seq: row.seq,
    occurredAt: row.occurredAt,
    action: row.action,
    resourceType: row.resourceType,
    resourceId: row.resourceId,
    details: row.details,
    actorId: row.actorId,
    actorRole: row.actorRole,
    correlationId: row.correlationId,
    prevHash: row.prevHash,
    hash: row.hash,
  };
}
