import type { DomainEventName, DomainEventPayloads, StoredDomainEvent } from "@/events";

/** Where a row is in its life. Mirrors the `OutboxStatus` enum in the schema. */
export type OutboxStatus = "PENDING" | "PUBLISHED" | "DEAD";

/**
 * An event on its way into the outbox.
 *
 * `eventId` and `occurredAt` are decided by the *stager*, inside the
 * transaction, not by the relay: the event happened when the transaction
 * committed, and the id has to survive every redelivery of it.
 *
 * Parameterised over one event name rather than being a union of all of them,
 * which is the opposite of {@link OutboxRecord} and deliberately so. A stager
 * knows statically which event it is writing, so `K` is pinned at the call site
 * and `payload` is checked against that one event; a *reader* knows only what
 * the `name` column said, which is a union and has to stay one. Writing this
 * side as a union too would force a cast in every stager, because TypeScript
 * cannot see that `{ name: K, payload: Payloads[K] }` is a member of the
 * distributive union it was distributed from.
 */
export interface NewOutboxEvent<K extends DomainEventName = DomainEventName> {
  readonly name: K;
  readonly payload: DomainEventPayloads[K];
  readonly eventId: string;
  readonly occurredAt: Date;
  readonly correlationId: string | null;
}

/**
 * A row the relay has claimed and is about to deliver.
 *
 * The union over `name`/`payload` comes from {@link StoredDomainEvent}, which is
 * what lets a record be handed straight to `DomainEventBus.publishAndSettle`
 * without a cast: a record whose `name` is `"user.deleted"` cannot be carrying
 * a registration payload as far as the type system is concerned.
 *
 * That guarantee is only as good as the check that produced the record. JSON
 * has no types, so `PrismaOutboxStore` validates `name` against the catalogue
 * on the way out and the payload is trusted — see the note in
 * `prisma-outbox.store.ts`, and `docs/outbox.md` for what that does and does
 * not cover.
 */
export type OutboxRecord = StoredDomainEvent & {
  /** Row id. Distinct from `eventId`, which is what goes on the wire. */
  readonly id: string;
  readonly eventId: string;
  readonly correlationId: string | null;
  readonly occurredAt: Date;
  /** Deliveries attempted *before* this one. Zero on the first claim. */
  readonly attempts: number;
};

/** What one claimed row did in one drain. */
export interface OutboxOutcome {
  readonly eventId: string;
  readonly name: string;
  readonly disposition: "published" | "retry" | "dead";
  /** The failure, for `retry` and `dead`. */
  readonly error?: string;
  /** When the relay will try again. Only for `retry`. */
  readonly nextAttemptAt?: Date;
}

/** What one drain did in total. */
export interface DrainReport {
  readonly claimed: number;
  readonly outcomes: readonly OutboxOutcome[];
}

export function emptyDrainReport(): DrainReport {
  return { claimed: 0, outcomes: [] };
}
