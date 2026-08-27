import {
  isDomainEventName,
  type DomainEventName,
  type DomainEventPayloads,
  type StoredDomainEvent,
} from "@/events";
import type { IncomingMessage, OutgoingMessage } from "./ports";
import { UndecodableMessageError } from "./messaging.errors";

/**
 * What one domain event looks like on the wire, both directions.
 *
 * The union over `name`/`payload` comes from `StoredDomainEvent` for the same
 * reason `OutboxRecord` uses it: it is what lets a decoded message be handed
 * straight to `DomainEventBus.publishAndSettle` without a cast, because a
 * message whose `name` is `"user.deleted"` cannot be carrying a registration
 * payload as far as the type system is concerned.
 */
export type EncodedDomainEvent = StoredDomainEvent & {
  readonly eventId: string;
  readonly occurredAt: Date;
  readonly correlationId: string | null;
};

/**
 * Kafka message headers this codec writes and reads.
 *
 * Metadata goes in headers and the payload goes in `value`, which is what Kafka
 * headers are for and what every tool in the ecosystem expects: `kafka-console-
 * consumer` prints them, Connect transforms route on them, and a consumer can
 * decide whether it cares about a message without deserialising the body.
 *
 * The cost is that `value` alone is not self-describing — an archived topic dump
 * without its headers cannot be interpreted. The alternative, an envelope object
 * wrapping the payload in `value`, moves the same information inside the bytes
 * and makes `Phase 10`'s schema-registry item awkward: a registry validates the
 * *payload* against the schema registered for it, and would then be validating a
 * wrapper this repository invented.
 */
export const EVENT_HEADERS = {
  /** The catalogue name. Checked against `DOMAIN_EVENT_NAMES` on the way in. */
  name: "event-name",
  /** Stable across every redelivery. What a consumer deduplicates on. */
  id: "event-id",
  /** ISO-8601. When the event happened, not when it was produced. */
  occurredAt: "event-occurred-at",
  /** The request that caused it, when the publisher knew. Absent when it did not. */
  correlationId: "correlation-id",
  /** So a future encoding is a new value here rather than a guess at the far end. */
  contentType: "content-type",
} as const;

export const EVENT_CONTENT_TYPE = "application/json";

/**
 * The partition key for each event in the catalogue.
 *
 * A mapped type over `DomainEventName`, so adding an event to the catalogue
 * without deciding how it is ordered is a compile error rather than a message
 * that silently round-robins across partitions and loses its order relative to
 * every other event about the same user.
 *
 * Every entry is the user id, which is the point: the aggregate the event is
 * about is what the key has to be. Keying on the *event id* instead — an
 * appealing mistake, since it is right there and unique — spreads one
 * aggregate's events across every partition, and `user.deleted` then arrives
 * before the `user.registered` it followed.
 */
const PARTITION_KEY: {
  readonly [K in DomainEventName]: (payload: DomainEventPayloads[K]) => string;
} = {
  "user.registered": (payload) => payload.userId,
  "user.deleted": (payload) => payload.userId,
};

export function partitionKeyFor(event: StoredDomainEvent): string {
  // The indexed access is narrowed by the union member, so `payload` is the one
  // this key function accepts. The cast is confined to this line because
  // TypeScript cannot see that `PARTITION_KEY[event.name]` and `event.payload`
  // were distributed from the same member.
  const key = PARTITION_KEY[event.name] as (
    payload: DomainEventPayloads[DomainEventName],
  ) => string;
  return key(event.payload);
}

/**
 * Every domain event goes to one topic, named by `KAFKA_DOMAIN_EVENTS_TOPIC`.
 *
 * One topic rather than one per event name, and the reason is ordering. Kafka
 * orders within a partition, and a partition belongs to a topic — so
 * `user.registered` on a `user-registered` topic and `user.deleted` on a
 * `user-deleted` topic have no order between them whatsoever, and a consumer
 * can be told an account was deleted before it hears it was created. Both
 * events keyed by user id on one topic land on one partition and arrive in the
 * order they happened.
 *
 * What that costs is selectivity: a consumer interested in one event type reads
 * all of them and filters on the `event-name` header. That is cheap here — the
 * catalogue is small and every event is about the same aggregate — and it stops
 * being the right trade when one event type dwarfs the others in volume, at
 * which point that one moves to its own topic and gives up cross-type ordering
 * knowingly.
 */
export function encodeDomainEvent(topic: string, event: EncodedDomainEvent): OutgoingMessage {
  const headers: Record<string, string> = {
    [EVENT_HEADERS.name]: event.name,
    [EVENT_HEADERS.id]: event.eventId,
    [EVENT_HEADERS.occurredAt]: event.occurredAt.toISOString(),
    [EVENT_HEADERS.contentType]: EVENT_CONTENT_TYPE,
  };
  // Omitted rather than sent empty: an absent header and a header whose value is
  // the empty string are different things on the wire, and `null` has no
  // spelling in a bytes-to-bytes map.
  if (event.correlationId !== null) {
    headers[EVENT_HEADERS.correlationId] = event.correlationId;
  }

  return {
    topic,
    key: partitionKeyFor(event),
    value: Buffer.from(JSON.stringify(event.payload), "utf8"),
    headers,
  };
}

/**
 * Turns a message back into an event, or explains why it cannot.
 *
 * `name` is validated against the catalogue because a topic is not a type: the
 * header is a string somebody else wrote, and a build that has removed an event
 * — or a producer from another system writing to the same topic — must not be
 * able to push an unknown name onto the bus. `payload` is *not* validated, which
 * is the same position `PrismaOutboxStore` takes for the same reason: there is
 * no runtime schema for these payloads anywhere in the repository, and inventing
 * one here would be a second source of truth that can drift from the catalogue.
 * `SPEC.md` Phase 10 item 3 is where that gap closes, against a registry rather
 * than against a hand-written guess.
 */
export function decodeDomainEvent(message: IncomingMessage): EncodedDomainEvent {
  function reject(reason: string): UndecodableMessageError {
    return new UndecodableMessageError(message.topic, message.partition, message.offset, reason);
  }

  const name = message.headers[EVENT_HEADERS.name];
  if (name === undefined) throw reject(`no "${EVENT_HEADERS.name}" header`);
  if (!isDomainEventName(name)) throw reject(`"${name}" is not an event this build knows`);

  const eventId = message.headers[EVENT_HEADERS.id];
  if (eventId === undefined || eventId === "") throw reject(`no "${EVENT_HEADERS.id}" header`);

  const occurredAtRaw = message.headers[EVENT_HEADERS.occurredAt];
  if (occurredAtRaw === undefined) throw reject(`no "${EVENT_HEADERS.occurredAt}" header`);
  const occurredAt = new Date(occurredAtRaw);
  if (Number.isNaN(occurredAt.getTime())) {
    throw reject(`"${EVENT_HEADERS.occurredAt}" is not a date: ${occurredAtRaw}`);
  }

  let payload: unknown;
  try {
    payload = JSON.parse(message.value.toString("utf8"));
  } catch (caught: unknown) {
    throw reject(`value is not JSON: ${caught instanceof Error ? caught.message : String(caught)}`);
  }
  // A JSON body may legally be `null`, a number or a string, none of which any
  // handler in the catalogue can read a field off. Caught here so the failure
  // names the message rather than surfacing later as a `TypeError` inside a
  // subscriber that looks like its own bug.
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw reject("value is not a JSON object");
  }

  const correlationId = message.headers[EVENT_HEADERS.correlationId] ?? null;

  // The one cast in the module, and it is the honest one: `name` has been
  // checked against the catalogue, but nothing has checked that the bytes
  // alongside it are the payload that name implies — JSON carries no types and
  // this repository has no runtime schema to check them against. See the note
  // above; Phase 10 item 3 is what removes it.
  return { name, payload, eventId, occurredAt, correlationId } as EncodedDomainEvent;
}
