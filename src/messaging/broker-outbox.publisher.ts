import { Inject, Injectable, Logger } from "@nestjs/common";
import { SpanKind, type Tracer } from "@opentelemetry/api";
import type { OutboxPublisher, OutboxRecord } from "@/outbox";
import { EventContract } from "@/schema-registry";
import { contextFromTraceCarrier, recordSpanError, tracerFor } from "@/telemetry";
import {
  ATTR_APP_EVENT_NAME,
  ATTR_MESSAGING_DESTINATION_NAME,
  ATTR_MESSAGING_MESSAGE_ID,
  ATTR_MESSAGING_OPERATION_NAME,
  ATTR_MESSAGING_SYSTEM,
} from "@/telemetry/semconv";
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
  private readonly tracer: Tracer = tracerFor("outbox");

  readonly name: string;

  constructor(
    @Inject(MESSAGE_BROKER) private readonly broker: MessageBroker,
    @Inject(DOMAIN_EVENTS_TOPIC) private readonly topic: string,
    private readonly contract: EventContract,
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
    // `encodeDomainEvent` validates the payload against its contract before it
    // writes a byte, and throws if it does not conform. The relay treats that
    // exactly as it treats a broker rejection — the row stays unpublished and is
    // retried — which is the right shape for a failure that a deploy fixes and a
    // retry does not: the row is still there afterwards, rather than having been
    // put on a topic every consumer is obliged to dead-letter.
    //
    // The span is the seam where the trace is stitched back together. Its
    // parent is the context the row was *staged* with — the request that caused
    // the event, minutes and a process ago — rather than the ambient context
    // here, which belongs to the relay's poll. `encodeDomainEvent` then injects
    // whatever is active, which is this span, so the consumer becomes its
    // child. See `docs/telemetry.md`.
    //
    // The operation name follows the messaging conventions:
    // `<destination> <operation>`, so a backend groups every publish to this
    // topic together without a rule about our naming.
    const parent = contextFromTraceCarrier(record.trace);
    await this.tracer.startActiveSpan(
      `${this.topic} send`,
      {
        kind: SpanKind.PRODUCER,
        attributes: {
          [ATTR_MESSAGING_SYSTEM]: this.broker.name,
          [ATTR_MESSAGING_OPERATION_NAME]: "send",
          [ATTR_MESSAGING_DESTINATION_NAME]: this.topic,
          // The event id, not the row id: it is what survives every redelivery
          // and what a consumer deduplicates on, so it is the id that lets a
          // published span and a consumed span be matched up by hand.
          [ATTR_MESSAGING_MESSAGE_ID]: record.eventId,
          [ATTR_APP_EVENT_NAME]: record.name,
        },
      },
      parent,
      async (span) => {
        try {
          await this.broker.produce([encodeDomainEvent(this.topic, record, this.contract)]);
        } catch (caught: unknown) {
          // Recorded and rethrown. The relay is what decides the row's fate —
          // retry or dead letter — and a publisher that swallowed the failure
          // to keep its span tidy would mark an unpublished event delivered.
          recordSpanError(span, caught);
          throw caught;
        } finally {
          span.end();
        }
      },
    );
    this.logger.debug(`Published ${record.name} (${record.eventId}) to ${this.topic}`);
  }
}
