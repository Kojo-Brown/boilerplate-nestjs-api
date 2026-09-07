import { Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "@/common/prisma/prisma.service";
import { requirePrismaTransaction } from "@/common/prisma/prisma-transaction.runner";
import type { TransactionContext } from "@/common/prisma/transaction.port";
import { isJsonObject } from "./saga-instance";
import type {
  NewSagaInstance,
  SagaInstanceRecord,
  SagaProgress,
  SagaStatus,
  SagaStepLogEntry,
} from "./saga-instance";
import type { SagaState } from "./saga-state";
import type { SagaClaim, SagaStore } from "./ports";

/** A row as Postgres hands it back. `state` and `log` are `jsonb`. */
interface SagaRow {
  id: string;
  name: string;
  status: SagaStatus;
  cursor: number;
  attempts: number;
  nextAttemptAt: Date;
  state: Prisma.JsonValue;
  log: Prisma.JsonValue;
  lastError: string | null;
  correlationId: string | null;
  lockedBy: string | null;
  lockedUntil: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * The Postgres-backed saga store.
 *
 * Three of the five operations are raw SQL, and each is raw for the same
 * reason: it has to be one statement. A claim expressed as a read followed by a
 * write is two, and between them a second runner reads the same free lease —
 * which is the one thing a lease exists to prevent. Prisma's `updateMany` can
 * express the condition but not return the row it matched, so `RETURNING` is
 * what makes the atomic form usable at all.
 *
 * Every interpolation below is a Prisma tagged-template parameter, bound rather
 * than concatenated.
 */
@Injectable()
export class PrismaSagaStore implements SagaStore {
  constructor(private readonly prisma: PrismaService) {}

  async create(tx: TransactionContext, instance: NewSagaInstance): Promise<SagaInstanceRecord> {
    const client = requirePrismaTransaction(tx, PrismaSagaStore.name);
    const row = await client.sagaInstance.create({
      data: {
        id: instance.id,
        name: instance.name,
        // The state is JSON by construction — `SagaState` is a JSON type, and
        // the compiler has already checked the concrete state against it. This
        // is the same widening `PrismaOutboxStore.stage` makes for a payload,
        // and for the same reason: `InputJsonValue` cannot be inferred from an
        // arbitrary index-signature type.
        state: instance.state as Prisma.InputJsonObject,
        correlationId: instance.correlationId,
      },
    });
    return toRecord(row);
  }

  async find(id: string): Promise<SagaInstanceRecord | null> {
    const row = await this.prisma.sagaInstance.findUnique({ where: { id } });
    return row ? toRecord(row) : null;
  }

  async claim(id: string, claim: SagaClaim): Promise<SagaInstanceRecord | null> {
    const until = new Date(claim.now.getTime() + claim.leaseMs);
    const rows = await this.prisma.$queryRaw<SagaRow[]>(Prisma.sql`
      UPDATE "saga_instances"
         SET "lockedBy" = ${claim.owner},
             "lockedUntil" = ${until},
             "updatedAt" = ${claim.now}
       WHERE "id" = ${id}
         AND "status" IN ('RUNNING'::"SagaStatus", 'COMPENSATING'::"SagaStatus")
         AND "nextAttemptAt" <= ${claim.now}
         AND ("lockedUntil" IS NULL OR "lockedUntil" <= ${claim.now})
      RETURNING *
    `);
    const row = rows[0];
    return row ? toRecord(row) : null;
  }

  /**
   * The recovery poller's claim.
   *
   * `FOR UPDATE SKIP LOCKED` inside the sub-select, exactly as the outbox
   * claims its batch — not because the lease needs a row lock, but because two
   * pollers running this statement at the same instant would otherwise both
   * select the same ids and one would silently overwrite the other's lease
   * before either had done any work. The lock is held for the duration of one
   * `UPDATE`, not for the duration of a saga step.
   */
  async claimDue(claim: SagaClaim, limit: number): Promise<readonly SagaInstanceRecord[]> {
    const until = new Date(claim.now.getTime() + claim.leaseMs);
    const rows = await this.prisma.$queryRaw<SagaRow[]>(Prisma.sql`
      UPDATE "saga_instances"
         SET "lockedBy" = ${claim.owner},
             "lockedUntil" = ${until},
             "updatedAt" = ${claim.now}
       WHERE "id" IN (
               SELECT "id"
                 FROM "saga_instances"
                WHERE "status" IN ('RUNNING'::"SagaStatus", 'COMPENSATING'::"SagaStatus")
                  AND "nextAttemptAt" <= ${claim.now}
                  AND ("lockedUntil" IS NULL OR "lockedUntil" <= ${claim.now})
                ORDER BY "nextAttemptAt" ASC, "id" ASC
                LIMIT ${limit}
                  FOR UPDATE SKIP LOCKED
             )
      RETURNING *
    `);
    return rows.map(toRecord);
  }

  async save(
    id: string,
    claim: SagaClaim,
    progress: SagaProgress,
  ): Promise<SagaInstanceRecord | null> {
    const until = progress.release ? null : new Date(claim.now.getTime() + claim.leaseMs);
    const rows = await this.prisma.$queryRaw<SagaRow[]>(Prisma.sql`
      UPDATE "saga_instances"
         SET "status" = ${progress.status}::"SagaStatus",
             "cursor" = ${progress.cursor},
             "attempts" = ${progress.attempts},
             "nextAttemptAt" = ${progress.nextAttemptAt},
             "state" = ${JSON.stringify(progress.state)}::jsonb,
             -- Appended in SQL rather than read-modify-written in TypeScript:
             -- the log is the audit trail of a row two runners may reach for,
             -- and a client-side append would drop whatever the other one wrote
             -- between the read and the write.
             "log" = "log" || ${JSON.stringify([progress.entry])}::jsonb,
             "lastError" = ${progress.lastError},
             "lockedBy" = ${progress.release ? null : claim.owner},
             "lockedUntil" = ${until},
             "updatedAt" = ${claim.now}
       WHERE "id" = ${id}
         AND "lockedBy" = ${claim.owner}
      RETURNING *
    `);
    const row = rows[0];
    return row ? toRecord(row) : null;
  }

  async abandon(id: string, status: Extract<SagaStatus, "STUCK">, reason: string): Promise<void> {
    await this.prisma.sagaInstance.update({
      where: { id },
      // Unconditional on the lease, deliberately: this is for an instance no
      // runner can advance at all, so waiting for the current lease holder to
      // agree would mean waiting for a runner that is about to refuse it too.
      data: { status, lastError: reason, lockedBy: null, lockedUntil: null },
    });
  }

  async countByStatus(): Promise<Record<SagaStatus, number>> {
    const grouped = await this.prisma.sagaInstance.groupBy({
      by: ["status"],
      _count: { _all: true },
    });
    const counts: Record<SagaStatus, number> = {
      RUNNING: 0,
      COMPENSATING: 0,
      COMPLETED: 0,
      COMPENSATED: 0,
      STUCK: 0,
    };
    for (const group of grouped) counts[group.status] = group._count._all;
    return counts;
  }
}

/**
 * Turns a row into a record.
 *
 * `state` and `log` are `jsonb`, so the database guarantees they are valid JSON
 * and nothing more — it has no opinion about shape. Both are checked for the
 * shape the orchestrator will index into rather than cast blindly: a state that
 * came back as an array would otherwise spread into `{ "0": … }` and a step
 * would read `undefined` where it expected an id.
 */
function toRecord(row: SagaRow): SagaInstanceRecord {
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    cursor: row.cursor,
    attempts: row.attempts,
    nextAttemptAt: row.nextAttemptAt,
    state: isJsonObject(row.state) ? (row.state as SagaState) : {},
    log: Array.isArray(row.log) ? (row.log as unknown as SagaStepLogEntry[]) : [],
    lastError: row.lastError,
    correlationId: row.correlationId,
    lockedBy: row.lockedBy,
    lockedUntil: row.lockedUntil,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
