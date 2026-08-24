/**
 * A row naming an event this build does not have.
 *
 * Reachable exactly one way: a deploy removed an entry from
 * `DomainEventPayloads` while rows staged under it were still pending. The row
 * is dead-lettered rather than retried — a later build is not going to grow the
 * event back, and a relay that kept re-reading it would make no progress on
 * that row for as long as it existed.
 */
export class UnknownOutboxEventError extends Error {
  constructor(
    readonly eventId: string,
    /** `eventName`, not `name` — `Error` already owns that one. */
    readonly eventName: string,
  ) {
    super(
      `Outbox event ${eventId} names "${eventName}", which is not in DomainEventPayloads. ` +
        `It was staged by a build that knew this event and cannot be published by this one.`,
    );
    this.name = "UnknownOutboxEventError";
  }
}

/**
 * At least one subscriber failed, so the event is not delivered.
 *
 * Specific to `DomainEventBusPublisher`: with an in-process bus, "the broker
 * accepted it" can only mean "every subscriber handled it", since there is no
 * broker in between to hold the message on their behalf. That makes the
 * retry unit the whole event rather than the failed handler, which is the
 * trade an in-process publisher forces — see `docs/outbox.md`.
 */
export class SubscriberFailedError extends Error {
  constructor(
    readonly eventId: string,
    readonly failures: readonly string[],
  ) {
    super(
      `Outbox event ${eventId} was refused by ${failures.length} subscriber(s): ${failures.join("; ")}`,
    );
    this.name = "SubscriberFailedError";
  }
}

/** A publish that did not answer within the relay's budget. */
export class PublishTimeoutError extends Error {
  constructor(
    readonly eventId: string,
    readonly timeoutMs: number,
  ) {
    super(`Publishing outbox event ${eventId} exceeded ${timeoutMs}ms`);
    this.name = "PublishTimeoutError";
  }
}
