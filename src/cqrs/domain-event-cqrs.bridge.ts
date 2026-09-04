import { Injectable } from "@nestjs/common";
import { EventBus } from "@nestjs/cqrs";
import { OnDomainEvent } from "@/events";
import type { DomainEvent, DomainEventName } from "@/events";
import { toNotification } from "./domain-event-notifications";

/** The names this bridge has a method for. Kept in step with them by hand. */
type BridgedEventName = "user.registered" | "user.deleted";

/**
 * Adding an event to the catalogue without adding a method below is a compile
 * error, in the same shape as `DOMAIN_EVENT_NAMES`' own check. The failure it
 * prevents is silent: every `@EventsHandler` for the new event would be
 * registered, resolve, and simply never run.
 */
type UnbridgedEventName = Exclude<DomainEventName, BridgedEventName>;
type BridgedNonEvent = Exclude<BridgedEventName, DomainEventName>;
const _EVERY_EVENT_IS_BRIDGED: [UnbridgedEventName, BridgedNonEvent] extends [never, never]
  ? true
  : never = true;
void _EVERY_EVENT_IS_BRIDGED;

/**
 * Puts every domain event onto the CQRS `EventBus`, so `@EventsHandler()`
 * classes can react to them.
 *
 * This is a one-way adapter, and the direction is the whole design. There are
 * now two event mechanisms in the process and only one of them is a backbone:
 * `DomainEventBus` is fed by the outbox relay and by `DomainEventConsumer`, so
 * what arrives there has been committed with the write that caused it and, for
 * anything that crossed the broker, was written by a producer whose payload
 * passed the schema registry. The CQRS bus is fed by this class and by nothing
 * else. No command handler publishes an integration event onto it, which is
 * what keeps the ordering honest: an event exists because a row was written,
 * not because a handler said so.
 *
 * ### What a CQRS event handler may therefore do
 *
 * `EventBus.publish` is `subject$.next(event)` — it returns before any handler
 * has finished, reports nothing about them, and retries nothing. A handler that
 * throws is caught by the bus's `catchError` and pushed onto
 * `UnhandledExceptionBus`, which by default has no subscriber at all; that is
 * what {@link CqrsUnhandledExceptionLogger} exists to fix. So a projection
 * whose loss would be a correctness bug does not belong here — it belongs on
 * `@OnDomainEvent`, where `publishAndSettle` names the handler that failed and
 * the outbox relay can hold the row back. What belongs here is work that is
 * safe to lose and cheap to redo: cache eviction, in-memory read models
 * rebuilt on demand.
 *
 * Forwarding happens through `@OnDomainEvent`, not by reaching into the
 * emitter, so the bridge is contained and attributed exactly like any other
 * subscriber: an `EventBus` that somehow threw would be reported as a failed
 * handler on this class rather than failing the relay's publish.
 */
@Injectable()
export class DomainEventCqrsBridge {
  constructor(private readonly eventBus: EventBus) {}

  @OnDomainEvent("user.registered")
  onUserRegistered(event: DomainEvent<"user.registered">): void {
    this.forward(event);
  }

  @OnDomainEvent("user.deleted")
  onUserDeleted(event: DomainEvent<"user.deleted">): void {
    this.forward(event);
  }

  private forward<K extends DomainEventName>(event: DomainEvent<K>): void {
    this.eventBus.publish(toNotification(event));
  }
}
