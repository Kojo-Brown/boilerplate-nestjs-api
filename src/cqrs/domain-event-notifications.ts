import type { DomainEvent, DomainEventName, DomainEventPayloads } from "@/events";

/**
 * A domain event, wrapped in a class so `@EventsHandler()` can name it.
 *
 * `@nestjs/cqrs` dispatches on the *constructor* of the published object —
 * `EventBus` reads `Object.getPrototypeOf(event).constructor` and looks the
 * handler up by that. The catalogue in `src/events/domain-event.ts` keys on a
 * string instead, so the two cannot meet without a class per event name; this
 * is that class, and it holds the envelope rather than copying fields out of
 * it, so a handler still sees the id, the `occurredAt` and the correlation id
 * the publisher set.
 *
 * The envelope stays the single source of truth deliberately. A notification
 * that flattened `payload` into its own constructor arguments would be a second
 * definition of every event's shape, free to drift from the interface the
 * outbox, the broker codec and the schema registry all agree on.
 */
export abstract class DomainEventNotification<K extends DomainEventName = DomainEventName> {
  constructor(readonly envelope: DomainEvent<K>) {}

  /** Unique per emission, and stable across an outbox redelivery. */
  get id(): string {
    return this.envelope.id;
  }

  get name(): K {
    return this.envelope.name;
  }

  get payload(): DomainEventPayloads[K] {
    return this.envelope.payload;
  }
}

/** A new account exists. See {@link import("@/events").UserRegisteredPayload}. */
export class UserRegisteredEvent extends DomainEventNotification<"user.registered"> {}

/** An account is gone. See {@link import("@/events").UserDeletedPayload}. */
export class UserDeletedEvent extends DomainEventNotification<"user.deleted"> {}

/**
 * The catalogue, as constructors.
 *
 * A mapped type rather than a plain object literal: the compiler refuses this
 * declaration if an event name is missing or if a name is paired with a
 * notification class built for a different one, so adding an entry to
 * `DomainEventPayloads` fails the build here rather than going quietly
 * unbridged — which would look exactly like a handler that never fires.
 */
export const DOMAIN_EVENT_NOTIFICATIONS: {
  [K in DomainEventName]: new (envelope: DomainEvent<K>) => DomainEventNotification<K>;
} = {
  "user.registered": UserRegisteredEvent,
  "user.deleted": UserDeletedEvent,
};

/** Wraps an envelope in the notification class registered for its name. */
export function toNotification<K extends DomainEventName>(
  envelope: DomainEvent<K>,
): DomainEventNotification<K> {
  const Notification = DOMAIN_EVENT_NOTIFICATIONS[envelope.name];
  return new Notification(envelope);
}
