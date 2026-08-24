import { Injectable, Logger } from "@nestjs/common";
import { EventEmitter2 } from "@nestjs/event-emitter";
import { randomUUID } from "crypto";
import type {
  DomainEvent,
  DomainEventName,
  DomainEventPayloads,
  HandlerOutcome,
} from "./domain-event";
import { isHandlerOutcome } from "./on-domain-event";

/** What the publisher knew about the wider operation, if anything. */
export interface PublishContext {
  /** The `x-correlation-id` of the request that caused this, when available. */
  readonly correlationId?: string | null;
  /**
   * The identity to publish under, instead of a fresh one.
   *
   * Only a *re*-publisher supplies this, and today that means the outbox relay.
   * The id is what a subscriber deduplicates on, and outbox delivery is
   * at-least-once — so a redelivery that minted a new id would be
   * indistinguishable from a second event, which is precisely what the id
   * exists to rule out. Ordinary publishers leave it unset and get a fresh
   * `randomUUID()`.
   */
  readonly eventId?: string;
  /**
   * When the thing happened, instead of when it was published.
   *
   * Same reason: a relayed event happened when its row was written inside the
   * transaction, not when the poller got round to it. For a direct publish the
   * two are the same moment and this stays unset.
   */
  readonly occurredAt?: Date;
}

/** Every subscriber's result for one emission. */
export interface PublishReport<K extends DomainEventName = DomainEventName> {
  readonly event: DomainEvent<K>;
  readonly outcomes: readonly HandlerOutcome[];
  /** The subset of `outcomes` that failed. Empty on a clean publish. */
  readonly failed: readonly HandlerOutcome[];
}

/**
 * The Subject of the Observer pattern: publishers announce that something
 * happened, and whoever cares reacts.
 *
 * The point is the direction of the dependency. `AuthService` needs no
 * reference to the notifications module to get a welcome email sent, so adding
 * a second reaction to a registration — provisioning a workspace, warming a
 * cache, writing an audit row — is a new listener class rather than another
 * line in `register()` and another constructor argument. The publisher does not
 * know how many subscribers exist, and must not care.
 *
 * Two ways to publish, and the difference matters:
 *
 * - {@link publish} returns as soon as every handler has started. Nothing a
 *   subscriber does can fail, slow, or roll back the operation that emitted the
 *   event. This is what production code wants.
 * - {@link publishAndSettle} waits for all of them and reports what each one
 *   did. This is what tests want, and what a caller that genuinely depends on
 *   the reactions — a job runner, the future outbox relay — needs.
 *
 * ### What this is not
 *
 * Delivery is in-process and in-memory. A subscriber that is mid-flight when
 * the process dies is simply gone, and nothing reaches another replica. Events
 * are also published from inside service methods, so one emitted before a later
 * statement throws describes something that did not finally happen. Both are
 * the known limits of an event emitter and the reason `SPEC.md` carries a
 * transactional-outbox item: the fix is to write the event in the same
 * transaction as the data and relay it afterwards, at which point this bus
 * becomes the relay's delivery mechanism rather than the source of truth.
 * Until then, do not publish anything whose loss would be a correctness bug.
 */
@Injectable()
export class DomainEventBus {
  private readonly logger = new Logger(DomainEventBus.name);

  constructor(private readonly emitter: EventEmitter2) {}

  /**
   * Announces that something happened, and returns the envelope that was sent
   * so the caller can log its id.
   *
   * Deliberately not `async`: awaiting subscribers is the coupling this exists
   * to break, and a `void` return that callers might be tempted to await is
   * less useful than the event itself.
   */
  publish<K extends DomainEventName>(
    name: K,
    payload: DomainEventPayloads[K],
    context: PublishContext = {},
  ): DomainEvent<K> {
    const event = this.envelope(name, payload, context);
    this.dispatch(event).catch((caught: unknown) => {
      // Unreachable through `@OnDomainEvent`, which resolves rather than
      // rejects. Reachable if someone registers a raw `@OnEvent` listener with
      // `suppressErrors: false`, and an unhandled rejection there would take
      // the process down instead of dropping one reaction.
      const error = caught instanceof Error ? caught.message : String(caught);
      this.logger.error(`Dispatching ${event.name} (${event.id}) rejected: ${error}`);
    });
    return event;
  }

  /**
   * {@link publish}, but waits for every subscriber and reports each one.
   *
   * Handlers registered with {@link import("./on-domain-event").OnDomainEvent}
   * are named individually in the report, including the ones that failed. A
   * plain `@OnEvent` listener is counted but always reported as `ok`, because
   * the framework swallows its errors before this ever sees them.
   */
  async publishAndSettle<K extends DomainEventName>(
    name: K,
    payload: DomainEventPayloads[K],
    context: PublishContext = {},
  ): Promise<PublishReport<K>> {
    const event = this.envelope(name, payload, context);
    const outcomes = await this.dispatch(event);
    return { event, outcomes, failed: outcomes.filter((outcome) => outcome.status === "failed") };
  }

  private envelope<K extends DomainEventName>(
    name: K,
    payload: DomainEventPayloads[K],
    context: PublishContext,
  ): DomainEvent<K> {
    return {
      id: context.eventId ?? randomUUID(),
      name,
      occurredAt: (context.occurredAt ?? new Date()).toISOString(),
      correlationId: context.correlationId ?? null,
      payload,
    };
  }

  private async dispatch<K extends DomainEventName>(
    event: DomainEvent<K>,
  ): Promise<readonly HandlerOutcome[]> {
    // `emitAsync` is declared to return a promise, but its first statement is a
    // `return false` for an emitter with no listener table. `EventEmitter2`'s
    // constructor creates that table, so the path is unreachable as things
    // stand — the check costs one comparison and turns any future `false` into
    // an empty report instead of a `TypeError` on `.then` at every call site.
    const emitted = this.emitter.emitAsync(event.name, event) as Promise<unknown[]> | false;
    if (emitted === false) return [];

    const results = await emitted;
    return results.map((result, index): HandlerOutcome =>
      isHandlerOutcome(result) ? result : { handler: `listener#${index}`, status: "ok" },
    );
  }
}
