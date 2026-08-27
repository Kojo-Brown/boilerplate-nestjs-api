import { Inject, Injectable, Logger } from "@nestjs/common";
import type { OutboxPublisher, OutboxRecord } from "@/outbox";
import { MESSAGE_BROKER, type MessageBroker } from "./ports";
import { DOMAIN_EVENTS_TOPIC } from "./messaging.tokens";
import { encodeDomainEvent } from "./domain-event-codec";

/**
 * The producer half of Phase 10, and the binding `OUTBOX_PUBLISHER` was written
 * for.
 *
 * `outbox-publisher.port.ts` predicted this exactly: "The Kafka producer in
 * `SPEC.md` Phase 10 binds to this token, and nothing in
 * `outbox-relay.service.ts` changes when it does." Nothing did. The relay still
 * claims rows with `SKIP LOCKED`, still calls `publish`, still treats a
 * rejection as "not delivered, try again later" — it has simply stopped being
 * true that delivery means "this process's subscribers".
 *
 * What changes for the system is the property `docs/outbox.md` listed under
 * *What this is still not*: with `DomainEventBusPublisher` a subscriber only
 * ever ran on the replica whose relay won the row, so an outbox event was
 * durable and retried but reached nobody else. Through a broker it reaches every
 * consumer group over the topic, on any replica and in any service.
 *
 * The two ends of the pipeline hold hands over the *event id*: the id minted by
 * `TransactionalOutbox.stage` inside the transaction travels as a header and
 * comes out the far side unchanged, through however many redeliveries either
 * half contributes. Both halves are at-least-once and neither can be configured
 * out of it, so that id is the only thing a consumer can deduplicate on.
 */
@Injectable()
export class BrokerOutboxPublisher implements OutboxPublisher {
  private readonly logger = new Logger(BrokerOutboxPublisher.name);

  readonly name: string;

  constructor(
    @Inject(MESSAGE_BROKER) private readonly broker: MessageBroker,
    @Inject(DOMAIN_EVENTS_TOPIC) private readonly topic: string,
  ) {
    // Named for the backend, not the class: this string ends up in the relay's
    // startup line and in dead-letter rows, where "broker" would leave an
    // operator unable to tell a real cluster from the in-process double.
    this.name = `${broker.name}:${topic}`;
  }

  async publish(record: OutboxRecord): Promise<void> {
    // One message per call rather than a batch, because the relay's unit of
    // work is a row: it marks each one `PUBLISHED` on its own promise, and a
    // batch send would make one broker rejection fail rows that were written.
    // The per-message cost is a round trip the relay is already paying inside
    // the transaction it holds.
    await this.broker.produce([encodeDomainEvent(this.topic, record)]);
    this.logger.debug(`Published ${record.name} (${record.eventId}) to ${this.topic}`);
  }
}
