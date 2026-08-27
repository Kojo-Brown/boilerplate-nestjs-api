import type { OutboxRecord } from "../outbox-record";

/** DI token for {@link OutboxPublisher}. */
export const OUTBOX_PUBLISHER = Symbol("OUTBOX_PUBLISHER");

/**
 * Which implementation the relay delivers through.
 *
 * `bus` is `DomainEventBusPublisher` — this process's subscribers, durable and
 * retried but reaching nobody else. `broker` is `BrokerOutboxPublisher`, which
 * produces to `KAFKA_DOMAIN_EVENTS_TOPIC` and is read by every consumer group
 * over it.
 *
 * Declared here rather than in `config/env.schema.ts` so the module owns its own
 * vocabulary, matching `MESSAGE_BROKER_NAMES` and `WORKER_POOL_NAMES`.
 */
export const OUTBOX_PUBLISHER_NAMES = ["bus", "broker"] as const;

export type OutboxPublisherName = (typeof OUTBOX_PUBLISHER_NAMES)[number];

/**
 * The broker seam.
 *
 * This is the one interface between the relay and whatever actually carries
 * events off this process. The relay knows nothing else about delivery: it
 * claims rows, calls `publish`, and treats a rejection as "not delivered, try
 * again later".
 *
 * Two implementations ship, selected by `OUTBOX_PUBLISHER`.
 * `DomainEventBusPublisher` hands the event to the in-process bus and is the
 * default: it makes the outbox useful with nothing installed (events survive a
 * crash and are retried, which they did not) while leaving the property it
 * cannot provide plainly stated — an in-process bus does not reach another
 * replica, so a subscriber only ever runs on the machine whose relay won the
 * row. `BrokerOutboxPublisher` produces to Kafka and does reach them.
 *
 * The prediction this comment used to make came true unmodified: the Kafka
 * producer binds to this token and nothing in `outbox-relay.service.ts`
 * changed when it did.
 */
export interface OutboxPublisher {
  /**
   * Hands one event to the broker, resolving only once the broker has accepted
   * it.
   *
   * Resolving means "durably accepted" and is what marks the row `PUBLISHED`.
   * An implementation that resolves on enqueue rather than on acknowledgement
   * turns the outbox back into at-most-once delivery, which is the failure this
   * whole mechanism exists to remove.
   *
   * Rejecting means "not delivered". The relay retries with backoff and
   * eventually dead-letters, so a rejection must be safe to act on — see the
   * at-least-once note in `docs/outbox.md`: a publish that succeeded at the
   * broker and then failed to report so will be delivered twice.
   */
  publish(record: OutboxRecord): Promise<void>;

  /** Named in logs and dead-letter rows, so an operator knows what refused. */
  readonly name: string;
}
