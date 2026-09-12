import {
  isDomainEventName,
  type DomainEventName,
  type DomainEventPayloads,
  type StoredDomainEvent,
} from "@/events";
import { SchemaValidationError, type PayloadContract } from "@/schema-registry";
import { injectTraceContext } from "@/telemetry";
import type { IncomingMessage, OutgoingMessage } from "./ports";
import { SchemaContractViolationError, UndecodableMessageError } from "./messaging.errors";

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
 * What comes back off the wire: an event, plus the schema version the *writer*
 * validated it against.
 *
 * `null` when the message carries no `event-schema-version` header, which is not
 * an error and must not be: during the deploy that introduces schema validation,
 * every message already in the topic was written by a producer that had no
 * version to stamp. Rejecting those would dead-letter the entire retained log on
 * upgrade — the schema registry's first act would be to destroy the history it
 * exists to keep readable.
 *
 * The field is for diagnosis rather than dispatch. Nothing branches on it; the
 * reader always validates against its own latest schema (see `EventContract`),
 * and this is what turns a rejection into "written by v4, rejected by v2" in a
 * dead letter instead of a mystery.
 */
export type DecodedDomainEvent = EncodedDomainEvent & {
  readonly writerSchemaVersion: number | null;
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
  /**
   * Which version of the event's schema the producer validated against.
   *
   * A header rather than a prefix on `value`, which is where Confluent's clients
   * put the schema id (a magic byte and four bytes of id). The wire format here
   * is plain JSON on purpose — `kafka-console-consumer` prints it, `jq` reads
   * it — and prefixing the body with binary would end that for the sake of five
   * bytes. The cost is that a Confluent deserialiser cannot read this topic
   * without being told where to look, which `docs/schema-registry.md` says.
   *
   * Absent on messages written before this header existed. See
   * {@link DecodedDomainEvent.writerSchemaVersion} for why that is tolerated.
   */
  schemaVersion: "event-schema-version",
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
 *
 * The order events are keyed by user id too, not by order id, and the choice is
 * worth stating because the obvious answer is the other one. Keying by order id
 * orders one order's events; keying by user id orders one *customer's* — which
 * includes every one of their orders, since all of an order's events carry the
 * same user — so it is strictly stronger, and it is the only key under which
 * `user.deleted` cannot overtake the `order.confirmed` that preceded it. What
 * it costs is a hot partition for a customer who orders far more than anyone
 * else, which is a problem worth having later rather than an ordering bug worth
 * shipping now.
 */
const PARTITION_KEY: {
  readonly [K in DomainEventName]: (payload: DomainEventPayloads[K]) => string;
} = {
  "user.registered": (payload) => payload.userId,
  "user.deleted": (payload) => payload.userId,
  "order.placed": (payload) => payload.userId,
  "order.confirmed": (payload) => payload.userId,
  "order.cancelled": (payload) => payload.userId,
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
export function encodeDomainEvent(
  topic: string,
  event: EncodedDomainEvent,
  contract: PayloadContract,
): OutgoingMessage {
  // Throws `SchemaValidationError`, which is not caught here and should not be:
  // a payload that does not match its own contract is this service's bug, and
  // the caller is the outbox relay, which will leave the row unpublished and
  // retry it. That is the right outcome — a producer must not be able to put
  // bytes on a topic that its own consumers are obliged to dead-letter.
  const schemaVersion = contract.validate(event.name, event.payload);

  const headers: Record<string, string> = {
    [EVENT_HEADERS.name]: event.name,
    [EVENT_HEADERS.id]: event.eventId,
    [EVENT_HEADERS.occurredAt]: event.occurredAt.toISOString(),
    [EVENT_HEADERS.contentType]: EVENT_CONTENT_TYPE,
    [EVENT_HEADERS.schemaVersion]: schemaVersion.toString(),
  };
  // Omitted rather than sent empty: an absent header and a header whose value is
  // the empty string are different things on the wire, and `null` has no
  // spelling in a bytes-to-bytes map.
  if (event.correlationId !== null) {
    headers[EVENT_HEADERS.correlationId] = event.correlationId;
  }

  // `traceparent`, and `tracestate` when there is one, written by the global
  // propagator rather than by this file. Two things follow from doing it here
  // rather than at the call site.
  //
  // The names are W3C's and carry no `event-` prefix, because unlike every
  // header above them these are not this repository's invention: a consumer
  // written in another language, with an SDK that has never heard of this
  // service, finds its parent span by looking for exactly this key.
  //
  // And the context injected is the *active* one, which at this point is the
  // producer span `BrokerOutboxPublisher` opened — itself parented on the trace
  // context stored with the row. So the chain on the wire is request → outbox
  // publish → consumer, rather than the relay's poll → consumer that a context
  // captured at publish time alone would have produced.
  injectTraceContext(headers);

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
 * able to push an unknown name onto the bus.
 *
 * `payload` is validated too, against the schema the registry holds for that
 * name. It did not used to be, and the comment that stood here said why: there
 * was no runtime schema anywhere in the repository, and a hand-written guess at
 * one would have been a second source of truth free to drift from the catalogue.
 * The registry is that missing source of truth, and it does not drift because
 * `catalogue.spec.ts` fails when it does.
 *
 * The two failures are kept apart because they mean different things to whoever
 * reads the dead-letter topic. `UndecodableMessageError` says the bytes are not
 * a domain event at all — a foreign producer, a truncated value, a name from
 * another system. {@link SchemaContractViolationError} says they are plainly one
 * of ours and the payload has the wrong shape, which is a contract broken by a
 * service that shares this topic. Both skip the retry ladder: neither becomes
 * correct by being read again.
 */
export function decodeDomainEvent(
  message: IncomingMessage,
  contract: PayloadContract,
): DecodedDomainEvent {
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
  const writerSchemaVersion = readWriterVersion(message, reject);

  try {
    contract.validate(name, payload);
  } catch (caught: unknown) {
    if (!(caught instanceof SchemaValidationError)) throw caught;
    throw new SchemaContractViolationError(message, name, writerSchemaVersion, caught);
  }

  // The cast that used to be the honest hole in this module is now merely a
  // limit of the type system: `name` has been checked against the catalogue and
  // `payload` has been checked against that name's schema, but TypeScript cannot
  // see that the two checks were about the same union member, so it will not
  // collapse `name`/`payload` into one branch of `StoredDomainEvent` by itself.
  return {
    name,
    payload,
    eventId,
    occurredAt,
    correlationId,
    writerSchemaVersion,
  } as DecodedDomainEvent;
}

/**
 * The producer's schema version, or `null` when it did not send one.
 *
 * A header that is present and *not* a version is a different matter from one
 * that is absent: absent means "written before this existed", where `v2` or an
 * empty string means a producer is writing something this format does not
 * define, and guessing what it meant is how a decoder ends up trusting a number
 * it invented.
 */
function readWriterVersion(
  message: IncomingMessage,
  reject: (reason: string) => UndecodableMessageError,
): number | null {
  const raw = message.headers[EVENT_HEADERS.schemaVersion];
  if (raw === undefined) return null;

  const version = Number(raw);
  if (!Number.isInteger(version) || version < 1) {
    throw reject(`"${EVENT_HEADERS.schemaVersion}" is not a version number: ${raw}`);
  }
  return version;
}
