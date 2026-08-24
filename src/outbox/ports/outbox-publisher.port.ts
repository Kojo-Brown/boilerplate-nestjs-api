import type { OutboxRecord } from "../outbox-record";

/** DI token for {@link OutboxPublisher}. */
export const OUTBOX_PUBLISHER = Symbol("OUTBOX_PUBLISHER");

/**
 * The broker seam.
 *
 * This is the one interface between the relay and whatever actually carries
 * events off this process. The relay knows nothing else about delivery: it
 * claims rows, calls `publish`, and treats a rejection as "not delivered, try
 * again later".
 *
 * One implementation ships today — `DomainEventBusPublisher`, which hands the
 * event to the in-process bus. That is deliberately the *default* rather than
 * the *design*: it makes the outbox useful immediately (events now survive a
 * crash and are retried, which they were not) while leaving the property it
 * cannot provide plainly stated — an in-process bus does not reach another
 * replica, so a subscriber only ever runs on the machine whose relay won the
 * row. The Kafka producer in `SPEC.md` Phase 10 binds to this token, and
 * nothing in `outbox-relay.service.ts` changes when it does.
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
