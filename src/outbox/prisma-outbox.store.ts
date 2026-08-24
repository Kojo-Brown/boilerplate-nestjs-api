import { Injectable, Logger } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "@/common/prisma/prisma.service";
import { requirePrismaTransaction } from "@/common/prisma/prisma-transaction.runner";
import type { TransactionContext } from "@/common/prisma/transaction.port";
import { isDomainEventName } from "@/events";
import type { DomainEventName, DomainEventPayloads } from "@/events";
import type {
  DrainReport,
  NewOutboxEvent,
  OutboxOutcome,
  OutboxRecord,
  OutboxStatus,
} from "./outbox-record";
import type { DrainOptions, OutboxStore } from "./ports";
import { UnknownOutboxEventError } from "./outbox.errors";

/**
 * How long the drain transaction may run.
 *
 * Longer than the 5s a request-path transaction gets, because this one spans a
 * whole batch of broker calls. It is still a bound rather than `Infinity`: a
 * broker that neither answers nor fails would otherwise hold the claim open
 * indefinitely, and the rows it claimed would be invisible to every other
 * replica for as long as that lasted. The relay's own per-publish timeout is
 * the first line of defence; this is the backstop.
 */
const DRAIN_TIMEOUT_MS = 30_000;
const DRAIN_MAX_WAIT_MS = 5_000;

/** One claimed row, as the raw claim query returns it. */
interface ClaimedRow {
  id: string;
  eventId: string;
  name: string;
  payload: Prisma.JsonValue;
  correlationId: string | null;
  occurredAt: Date;
  attempts: number;
}

/**
 * The Postgres-backed outbox.
 *
 * The two halves of the pattern live here, and neither is interesting on its
 * own: `stage` is one insert on somebody else's connection, and `drain` is one
 * `SELECT … FOR UPDATE SKIP LOCKED` followed by a publish and an update per
 * row. What makes it an outbox is which connection each of those runs on.
 */
@Injectable()
export class PrismaOutboxStore implements OutboxStore {
  private readonly logger = new Logger(PrismaOutboxStore.name);

  constructor(private readonly prisma: PrismaService) {}

  async stage(tx: TransactionContext, event: NewOutboxEvent): Promise<void> {
    const client = requirePrismaTransaction(tx, PrismaOutboxStore.name);
    await client.outboxEvent.create({
      data: {
        eventId: event.eventId,
        name: event.name,
        // The payloads in `DomainEventPayloads` are JSON-shaped by construction
        // (ids, strings, nulls — never a Prisma row; see docs/events.md), so
        // this is a widening rather than a conversion. Prisma's `InputJsonValue`
        // cannot be inferred from an arbitrary interface, which is what the
        // cast is for.
        payload: event.payload as unknown as Prisma.InputJsonObject,
        correlationId: event.correlationId,
        occurredAt: event.occurredAt,
      },
    });
  }

  async drain(options: DrainOptions): Promise<DrainReport> {
    return this.prisma.$transaction(
      async (client) => {
        const rows = await this.claim(client, options);
        const outcomes: OutboxOutcome[] = [];

        for (const row of rows) {
          outcomes.push(await this.deliverOne(client, row, options));
        }

        return { claimed: rows.length, outcomes };
      },
      { timeout: DRAIN_TIMEOUT_MS, maxWait: DRAIN_MAX_WAIT_MS },
    );
  }

  async countByStatus(): Promise<Record<OutboxStatus, number>> {
    const grouped = await this.prisma.outboxEvent.groupBy({
      by: ["status"],
      _count: { _all: true },
    });
    const counts: Record<OutboxStatus, number> = { PENDING: 0, PUBLISHED: 0, DEAD: 0 };
    for (const group of grouped) counts[group.status] = group._count._all;
    return counts;
  }

  /**
   * Takes the batch nobody else holds.
   *
   * Raw SQL because Prisma has no way to express `FOR UPDATE SKIP LOCKED`, and
   * that clause is not an optimisation here — it is the entire concurrency
   * story. Without `FOR UPDATE` two relays read the same rows and publish them
   * both; without `SKIP LOCKED` the second relay blocks on the first one's
   * batch for the whole of its broker round trip, so scaling out buys nothing.
   *
   * Ordering by `occurredAt` makes a single relay deliver in the order things
   * happened. It does not survive concurrent relays — see the ordering section
   * of `docs/outbox.md`, which says what that costs and what it would take to
   * fix.
   *
   * The interpolations are Prisma's tagged-template parameters, not string
   * concatenation: every value below is bound.
   */
  private claim(client: Prisma.TransactionClient, options: DrainOptions): Promise<ClaimedRow[]> {
    return client.$queryRaw<ClaimedRow[]>(Prisma.sql`
      SELECT "id", "eventId", "name", "payload", "correlationId", "occurredAt", "attempts"
        FROM "outbox_events"
       WHERE "status" = 'PENDING'::"OutboxStatus"
         AND "nextAttemptAt" <= ${options.now}
       ORDER BY "occurredAt" ASC, "id" ASC
       LIMIT ${options.batchSize}
         FOR UPDATE SKIP LOCKED
    `);
  }

  private async deliverOne(
    client: Prisma.TransactionClient,
    row: ClaimedRow,
    options: DrainOptions,
  ): Promise<OutboxOutcome> {
    let record: OutboxRecord;
    try {
      record = toRecord(row);
    } catch (caught: unknown) {
      // The event is not in this build's catalogue, so no amount of retrying
      // will help and no publisher could be asked to carry it. Dead-lettering
      // is the only honest disposition: the row stays, an operator can see it,
      // and the relay is not stuck re-reading it every second forever.
      const error = asError(caught);
      await this.markDead(client, row.id, row.attempts + 1, error);
      this.logger.error(`Outbox event ${row.eventId} is undeliverable: ${error.message}`);
      return { eventId: row.eventId, name: row.name, disposition: "dead", error: error.message };
    }

    try {
      await options.deliver(record);
      await client.outboxEvent.update({
        where: { id: row.id },
        data: { status: "PUBLISHED", publishedAt: options.now, attempts: row.attempts + 1 },
      });
      return { eventId: row.eventId, name: row.name, disposition: "published" };
    } catch (caught: unknown) {
      const error = asError(caught);
      const attempts = row.attempts + 1;
      const nextAttemptAt = options.retryAt(record, error);

      if (nextAttemptAt === null) {
        await this.markDead(client, row.id, attempts, error);
        this.logger.error(
          `Outbox event ${row.eventId} (${row.name}) dead-lettered after ${attempts} ` +
            `attempts: ${error.message}`,
        );
        return { eventId: row.eventId, name: row.name, disposition: "dead", error: error.message };
      }

      await client.outboxEvent.update({
        where: { id: row.id },
        data: { attempts, nextAttemptAt, lastError: truncate(error.message) },
      });
      return {
        eventId: row.eventId,
        name: row.name,
        disposition: "retry",
        error: error.message,
        nextAttemptAt,
      };
    }
  }

  private async markDead(
    client: Prisma.TransactionClient,
    id: string,
    attempts: number,
    error: Error,
  ): Promise<void> {
    await client.outboxEvent.update({
      where: { id },
      data: { status: "DEAD", attempts, lastError: truncate(error.message) },
    });
  }
}

/**
 * Turns a row back into a typed record.
 *
 * `name` is checked against the catalogue, because it is the discriminant: an
 * unrecognised one has to be caught here rather than reaching a subscriber
 * typed for a different payload.
 *
 * The payload itself is **not** validated, and that is a deliberate gap rather
 * than an oversight. There is no runtime schema for these payloads anywhere in
 * the repository — the catalogue is types only — so validating here would mean
 * inventing a second source of truth that can drift from the first. What that
 * leaves uncovered is a row written by an older build whose payload shape has
 * since changed; `docs/outbox.md` says so, and says what would close it.
 */
function toRecord(row: ClaimedRow): OutboxRecord {
  if (!isDomainEventName(row.name)) {
    throw new UnknownOutboxEventError(row.eventId, row.name);
  }
  const name: DomainEventName = row.name;
  return {
    id: row.id,
    eventId: row.eventId,
    correlationId: row.correlationId,
    occurredAt: row.occurredAt,
    attempts: row.attempts,
    name,
    payload: row.payload as unknown as DomainEventPayloads[typeof name],
  } as OutboxRecord;
}

function asError(caught: unknown): Error {
  return caught instanceof Error ? caught : new Error(String(caught));
}

/** `lastError` is a diagnostic, not a log. A stack trace in every row is not worth the storage. */
function truncate(message: string, limit = 500): string {
  return message.length <= limit ? message : `${message.slice(0, limit - 1)}…`;
}
