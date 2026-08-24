import { Injectable } from "@nestjs/common";
import { DomainEventBus } from "@/events";
import type { OutboxRecord } from "./outbox-record";
import type { OutboxPublisher } from "./ports";
import { SubscriberFailedError } from "./outbox.errors";

/**
 * Delivers relayed events to the in-process bus.
 *
 * This is the publisher `docs/events.md` predicted: with an outbox in front of
 * it, `DomainEventBus` stops being the source of truth for whether an event
 * happened and becomes the relay's delivery mechanism. The event is durable
 * before any subscriber sees it, and a subscriber that fails now gets the event
 * again on the next poll instead of dropping it.
 *
 * What it is not is a broker. Subscribers run in the process that won the row,
 * so this buys durability and retries but not fan-out across replicas. The
 * `OUTBOX_PUBLISHER` token is where that changes — see the port.
 */
@Injectable()
export class DomainEventBusPublisher implements OutboxPublisher {
  readonly name = "domain-event-bus";

  constructor(private readonly bus: DomainEventBus) {}

  async publish(record: OutboxRecord): Promise<void> {
    // `publishAndSettle`, not `publish`: the relay has to know whether the
    // reactions happened before it may mark the row delivered, and `publish`
    // returns as soon as they have started. This is the caller `events.md`
    // describes as "genuinely depending on the reactions".
    const report = await this.bus.publishAndSettle(record.name, record.payload, {
      // The row's identity and time, not fresh ones. A redelivery has to look
      // like the same event to a subscriber deduplicating on the id.
      eventId: record.eventId,
      occurredAt: record.occurredAt,
      correlationId: record.correlationId,
    });

    if (report.failed.length > 0) {
      throw new SubscriberFailedError(
        record.eventId,
        report.failed.map((outcome) => `${outcome.handler}: ${outcome.error ?? "unknown error"}`),
      );
    }
  }
}
