/**
 * The catalogue of things that have happened in this system.
 *
 * One interface is the single source of truth for every event name and the
 * shape that travels with it. Publishers and subscribers both index into it, so
 * a payload that changes breaks the handlers that read the removed field at
 * compile time rather than at 3am — which is the entire reason to put a type in
 * front of `EventEmitter2`, whose own signature is `emit(name: string,
 * ...values: any[])`.
 *
 * Adding an event is one entry here plus its payload interface. Nothing else in
 * `src/events` needs to change.
 */
export interface DomainEventPayloads {
  "user.registered": UserRegisteredPayload;
  "user.deleted": UserDeletedPayload;
  "order.placed": OrderPlacedPayload;
  "order.confirmed": OrderConfirmedPayload;
  "order.cancelled": OrderCancelledPayload;
}

/**
 * A new account exists — email + password or OAuth, the subscriber decides
 * whether it cares which.
 */
export interface UserRegisteredPayload {
  readonly userId: string;
  readonly email: string;
  /** Nullable: the column is optional and an OAuth profile may not supply one. */
  readonly name: string | null;
  /** `"google"` for OAuth sign-ups, `null` for email + password. */
  readonly provider: string | null;
}

/** An account is gone. Emitted after the row is deleted, not before. */
export interface UserDeletedPayload {
  readonly userId: string;
  /**
   * Carried on the event because the row no longer exists by the time a
   * subscriber runs: a handler that has to look the user up to find their
   * address cannot, which is the standard reason a deletion event is the one
   * event that must be self-contained.
   */
  readonly email: string;
}

/**
 * A customer has asked to buy something. Staged in the same transaction as the
 * order row and the saga that will drive it, so it cannot describe an order
 * that does not exist — and cannot be missing for one that does.
 *
 * "Placed" is not "paid". Nothing has been reserved, charged or shipped when
 * this is emitted; `order.confirmed` and `order.cancelled` are the outcomes.
 */
export interface OrderPlacedPayload {
  readonly orderId: string;
  readonly userId: string;
  /** Integer minor units, matching `src/payments/money.ts`. */
  readonly totalMinor: number;
  /** Upper-case ISO 4217. */
  readonly currency: string;
  /** How many lines, not how many units. Enough for a dashboard, no basket contents. */
  readonly lineCount: number;
}

/** Paid and shipped. The checkout saga completed. */
export interface OrderConfirmedPayload {
  readonly orderId: string;
  readonly userId: string;
  /** The gateway's payment id, for reconciliation. */
  readonly paymentId: string;
  readonly shipmentId: string;
}

/**
 * A checkout that could not be completed and was unwound.
 *
 * Emitted by the compensation that cancels the order, so by the time a
 * subscriber sees it the stock is back on the shelf and any money taken has
 * been refunded — which is what makes it safe for a subscriber to tell the
 * customer.
 */
export interface OrderCancelledPayload {
  readonly orderId: string;
  readonly userId: string;
  /** The failing step's message, as the customer will be shown it. */
  readonly reason: string;
}

export type DomainEventName = keyof DomainEventPayloads & string;

/**
 * The same catalogue as a value, because a type cannot be consulted at runtime.
 *
 * The outbox needs this: a row read back from `outbox_events` carries a `name`
 * column that is just a string as far as the database is concerned, and the
 * relay has to decide whether it is still an event this build knows how to
 * publish. An event deleted from the catalogue in a deploy that leaves rows
 * behind is the case — those rows are dead-lettered with a message saying so
 * rather than crashing the relay on every tick.
 */
export const DOMAIN_EVENT_NAMES = [
  "user.registered",
  "user.deleted",
  "order.placed",
  "order.confirmed",
  "order.cancelled",
] as const;

/**
 * Adding an event to {@link DomainEventPayloads} without adding it here is a
 * compile error: the outbox would accept the event and then fail to recognise
 * it on the way back out, which is a bug that would only ever appear in
 * production, one poll after the deploy.
 */
type UnlistedEventName = Exclude<DomainEventName, (typeof DOMAIN_EVENT_NAMES)[number]>;
type ListedNonEvent = Exclude<(typeof DOMAIN_EVENT_NAMES)[number], DomainEventName>;
const _EVERY_EVENT_IS_LISTED: [UnlistedEventName, ListedNonEvent] extends [never, never]
  ? true
  : never = true;
void _EVERY_EVENT_IS_LISTED;

export function isDomainEventName(value: unknown): value is DomainEventName {
  return typeof value === "string" && (DOMAIN_EVENT_NAMES as readonly string[]).includes(value);
}

/**
 * One stored event, as a discriminated union over the catalogue.
 *
 * `{ name: DomainEventName; payload: DomainEventPayloads[DomainEventName] }`
 * would allow `user.deleted` to carry a registration payload. This form does
 * not, and it is what lets the outbox hand a record straight to
 * `publishAndSettle` without a cast at the call site.
 */
export type StoredDomainEvent = {
  [K in DomainEventName]: { readonly name: K; readonly payload: DomainEventPayloads[K] };
}[DomainEventName];

/**
 * The envelope every subscriber receives.
 *
 * Events carry identifiers and the few facts a subscriber needs — never an ORM
 * row. A `User` on the bus would put the argon2 hash in front of every
 * listener, and would go stale the moment anything downstream awaited.
 *
 * Always write the parameter in a handler signature: `DomainEvent<"user.deleted">`
 * ties `payload` to that one event, where bare `DomainEvent` widens it to the
 * union of every payload. `@OnDomainEvent` enforces that for subscribers.
 */
export interface DomainEvent<K extends DomainEventName = DomainEventName> {
  /** Unique per emission. The handle a log line uses to follow one event. */
  readonly id: string;
  readonly name: K;
  /** ISO-8601, set when the event is published rather than when it is handled. */
  readonly occurredAt: string;
  /**
   * The request that caused this, when the publisher knew it.
   *
   * `null` from every current call site: `LoggingInterceptor` puts the id on the
   * request and nothing carries it down to a service, which would need
   * `AsyncLocalStorage` to do without threading it through every signature.
   * The field exists so that wiring stays a change in one place, and so a
   * publisher that *does* hold the id (a controller, the future outbox relay)
   * can pass it today.
   */
  readonly correlationId: string | null;
  readonly payload: DomainEventPayloads[K];
}

/**
 * Any event on the bus, as a discriminated union over the catalogue.
 *
 * Not the same type as bare `DomainEvent`, and the difference is the reason
 * this exists. `DomainEvent` defaults its parameter to the *union* of names, so
 * it widens to `{ name: "user.registered" | "user.deleted"; payload:
 * UserRegisteredPayload | UserDeletedPayload }` — a shape in which `name` and
 * `payload` are independent, so narrowing on `name` tells the compiler nothing
 * about `payload` and a `switch` over it has no exhaustive `never` branch.
 * Distributing over `K` first pairs each name with its own payload, which is
 * what lets a consumer that must handle every event — `isVisibleTo` in
 * `src/streaming` is the first — be checked for having done so.
 *
 * Use `DomainEvent<K>` in a handler for one event; use this only where the
 * whole catalogue is genuinely in play.
 */
export type AnyDomainEvent = { [K in DomainEventName]: DomainEvent<K> }[DomainEventName];

/**
 * What a subscriber method looks like.
 *
 * Returns `unknown` rather than `void | Promise<void>` so that
 * {@link import("./on-domain-event").OnDomainEvent} can replace the method with
 * a wrapper that reports a {@link HandlerOutcome}, and so a synchronous handler
 * is as valid as an async one.
 */
export type DomainEventHandler<K extends DomainEventName> = (event: DomainEvent<K>) => unknown;

/** How one subscriber fared with one event. */
export interface HandlerOutcome {
  /** `"WelcomeEmailListener.onUserRegistered"` — the class and method. */
  readonly handler: string;
  readonly status: "ok" | "failed";
  /** Present only when `status` is `"failed"`. */
  readonly error?: string;
}
