import type { TransactionContext } from "@/common/prisma/transaction.port";
import { isDomainEventName } from "@/events";
import { UnknownOutboxEventError } from "@/outbox";
import type { TraceCarrier } from "@/telemetry";
import type {
  DrainOptions,
  DrainReport,
  NewOutboxEvent,
  OutboxOutcome,
  OutboxRecord,
  OutboxStatus,
  OutboxStore,
} from "@/outbox";

interface Row {
  id: string;
  eventId: string;
  name: string;
  payload: unknown;
  correlationId: string | null;
  trace: TraceCarrier;
  occurredAt: Date;
  status: OutboxStatus;
  attempts: number;
  nextAttemptAt: Date;
  lastError: string | null;
  /** Held while a drain has this row claimed — the double's `FOR UPDATE SKIP LOCKED`. */
  claimed: boolean;
}

let sequence = 0;

/**
 * In-memory implementation of {@link OutboxStore}.
 *
 * It exists so the e2e suite can run the whole application — staging, relaying,
 * subscribers, the lot — without a Postgres. It is held to the same behavioural
 * contract as the Prisma adapter by `outbox-store.contract.spec.ts`, and the
 * contract is where the interesting differences would show up: a double that
 * handed the same row to two concurrent drains, or that kept a staged event
 * after its transaction rolled back, would make green e2e tests meaningless.
 *
 * What it deliberately does **not** claim is the property the pattern rests on.
 * Atomicity here comes from `tx.onRollback` — a compensation the runner invokes
 * when the callback throws — not from a transaction, so it cannot help with a
 * commit that fails after the callback returned, and it is not evidence about
 * SQL. `test/outbox-store.db-spec.ts` asserts that half against a real server.
 */
export class InMemoryOutboxStore implements OutboxStore {
  private readonly rows: Row[] = [];

  stage(tx: TransactionContext, event: NewOutboxEvent): Promise<void> {
    sequence += 1;
    const row: Row = {
      id: `outbox-${sequence}`,
      eventId: event.eventId,
      name: event.name,
      payload: event.payload,
      correlationId: event.correlationId,
      trace: event.trace,
      occurredAt: event.occurredAt,
      status: "PENDING",
      attempts: 0,
      nextAttemptAt: event.occurredAt,
      lastError: null,
      claimed: false,
    };
    this.rows.push(row);
    // The Prisma adapter needs nothing here: its insert is inside the caller's
    // transaction and Postgres discards it. A `Map` has no such courtesy, so the
    // double removes the row itself — otherwise a rolled-back registration
    // would still send a welcome email.
    tx.onRollback(() => {
      const index = this.rows.indexOf(row);
      if (index >= 0) this.rows.splice(index, 1);
    });
    return Promise.resolve();
  }

  async drain(options: DrainOptions): Promise<DrainReport> {
    const claimed = this.rows
      .filter((row) => row.status === "PENDING" && !row.claimed && row.nextAttemptAt <= options.now)
      .sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime() || a.id.localeCompare(b.id))
      .slice(0, options.batchSize);

    // Claimed before any delivery starts, so a concurrent drain skips them the
    // way `SKIP LOCKED` would rather than picking them up again.
    for (const row of claimed) row.claimed = true;

    const outcomes: OutboxOutcome[] = [];
    try {
      for (const row of claimed) {
        outcomes.push(await this.deliverOne(row, options));
      }
    } finally {
      for (const row of claimed) row.claimed = false;
    }

    return { claimed: claimed.length, outcomes };
  }

  countByStatus(): Promise<Record<OutboxStatus, number>> {
    const counts: Record<OutboxStatus, number> = { PENDING: 0, PUBLISHED: 0, DEAD: 0 };
    for (const row of this.rows) counts[row.status] += 1;
    return Promise.resolve(counts);
  }

  /** Every row, for tests that want to assert on what was staged. */
  all(): readonly Readonly<Row>[] {
    return this.rows;
  }

  reset(): void {
    this.rows.length = 0;
  }

  private async deliverOne(row: Row, options: DrainOptions): Promise<OutboxOutcome> {
    if (!isDomainEventName(row.name)) {
      const error = new UnknownOutboxEventError(row.eventId, row.name);
      row.status = "DEAD";
      row.attempts += 1;
      row.lastError = error.message;
      return { eventId: row.eventId, name: row.name, disposition: "dead", error: error.message };
    }

    const record = {
      id: row.id,
      eventId: row.eventId,
      correlationId: row.correlationId,
      trace: row.trace,
      occurredAt: row.occurredAt,
      attempts: row.attempts,
      name: row.name,
      payload: row.payload,
    } as OutboxRecord;

    try {
      await options.deliver(record);
      row.status = "PUBLISHED";
      row.attempts += 1;
      return { eventId: row.eventId, name: row.name, disposition: "published" };
    } catch (caught: unknown) {
      const error = caught instanceof Error ? caught : new Error(String(caught));
      row.attempts += 1;
      row.lastError = error.message;
      const next = options.retryAt(record, error);
      if (next === null) {
        row.status = "DEAD";
        return { eventId: row.eventId, name: row.name, disposition: "dead", error: error.message };
      }
      row.nextAttemptAt = next;
      return {
        eventId: row.eventId,
        name: row.name,
        disposition: "retry",
        error: error.message,
        nextAttemptAt: next,
      };
    }
  }
}
