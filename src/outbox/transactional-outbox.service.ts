import { Inject, Injectable } from "@nestjs/common";
import { randomUUID } from "crypto";
import type { TransactionContext } from "@/common/prisma/transaction.port";
import type { DomainEventName, DomainEventPayloads } from "@/events";
import type { NewOutboxEvent } from "./outbox-record";
import { OUTBOX_STORE, type OutboxStore } from "./ports";

/** What the stager knew about the wider operation. Mirrors `PublishContext`. */
export interface StageContext {
  readonly correlationId?: string | null;
}

/** The identity the event will be published under, returned so a caller can log it. */
export interface StagedEvent {
  readonly eventId: string;
  readonly name: DomainEventName;
  readonly occurredAt: Date;
}

/**
 * Announces that something happened, durably, as part of the caller's
 * transaction.
 *
 * The signature is deliberately the same shape as `DomainEventBus.publish`, so
 * moving a call site from the bus to the outbox is a change of collaborator and
 * a `tx` argument rather than a rewrite. The difference is in what the two
 * promise:
 *
 * - `bus.publish(name, payload)` reaches today's subscribers, in this process,
 *   right now, and is gone if the process is.
 * - `outbox.stage(tx, name, payload)` commits with the data or not at all, and
 *   is delivered afterwards by the relay, with retries.
 *
 * That second property is the one worth being precise about. The event cannot
 * describe something that did not happen, because a transaction that rolls back
 * takes the event with it; and the operation cannot succeed while the event is
 * lost, because the same commit carries both. Those are the two failures a bare
 * emitter has, and they are the reason `docs/events.md` says not to put
 * anything a user would notice missing on the bus.
 *
 * `stage` is `async` where `publish` is not, and that is not an inconsistency:
 * this one really does write to the database, and a caller that forgot to await
 * it would leave an insert racing its own transaction's commit.
 */
@Injectable()
export class TransactionalOutbox {
  constructor(@Inject(OUTBOX_STORE) private readonly store: OutboxStore) {}

  async stage<K extends DomainEventName>(
    tx: TransactionContext,
    name: K,
    payload: DomainEventPayloads[K],
    context: StageContext = {},
  ): Promise<StagedEvent> {
    const event = {
      eventId: randomUUID(),
      name,
      payload,
      correlationId: context.correlationId ?? null,
      // The event happened inside this transaction. Stamping it here rather
      // than at delivery is what keeps `occurredAt` meaningful when a relay is
      // behind, or when a row has been retried for an hour.
      occurredAt: new Date(),
    } satisfies NewOutboxEvent<K>;

    await this.store.stage(tx, event);
    return { eventId: event.eventId, name: event.name, occurredAt: event.occurredAt };
  }
}
