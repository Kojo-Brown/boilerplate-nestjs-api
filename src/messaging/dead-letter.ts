import type { IncomingMessage, OutgoingMessage } from "./ports";

/**
 * Why a message was given up on.
 *
 * Three values because there are three genuinely different failures, and an
 * operator reading the dead-letter topic needs to tell them apart before
 * deciding what to do.
 *
 * - `undecodable` — the bytes are not a domain event this build recognises.
 *   Nothing downstream ever ran, and redriving the message unchanged will fail
 *   the same way. Usually a foreign producer on the topic.
 * - `schema-invalid` — the bytes *are* one of our events and the payload does
 *   not match the contract for it. Redriving is equally pointless, but the fix
 *   is somewhere else entirely: a producer is emitting a shape the registry does
 *   not describe, and `dlt-error` names the writer's schema version and the
 *   reader's.
 * - `handler-failed` — the event was understood and a subscriber kept rejecting
 *   it. The payload is fine, something it depends on was not, and redriving once
 *   that is fixed is exactly the right move.
 *
 * The first two are separated rather than folded together because the *owner* of
 * the problem differs. "Stop that system writing to our topic" and "that
 * service skipped a schema version" are different pages, and having to
 * deserialise the payload to work out which is not a reasonable thing to ask of
 * whoever is on call.
 */
export type DeadLetterReason = "undecodable" | "schema-invalid" | "handler-failed";

/**
 * Headers added to a message on its way to the dead-letter topic.
 *
 * Everything an operator needs to answer the three questions a dead letter
 * raises — what failed, why, and where the original is — without deserialising
 * the body or correlating against a log. The `dlt-` prefix is not a convention
 * Kafka enforces; it is here so a redrive tool can strip this set and leave the
 * producer's own headers untouched, and so a collision with a header the
 * producer wrote is impossible in practice.
 *
 * The origin coordinates are the important ones. A partition and an offset are
 * what `kafka-console-consumer --partition --offset` takes, so a record can be
 * read back off the source topic exactly as it was received, which is the only
 * way to be sure the copy on the dead-letter topic is faithful.
 */
export const DEAD_LETTER_HEADERS = {
  /** A {@link DeadLetterReason}. */
  reason: "dlt-reason",
  /** The last error's message, truncated. Diagnosis, not a machine contract. */
  error: "dlt-error",
  /** The last error's constructor name, which *is* stable enough to route on. */
  errorType: "dlt-error-type",
  /** How many attempts were made. `1` for a message that was never retryable. */
  attempts: "dlt-attempts",
  /** The consumer group that gave up. Two groups can dead-letter the same record. */
  group: "dlt-consumer-group",
  /** Where the original record lives, so it can be read back by hand. */
  originTopic: "dlt-origin-topic",
  originPartition: "dlt-origin-partition",
  originOffset: "dlt-origin-offset",
  /** When this process gave up. Not the record's own timestamp, which is preserved. */
  failedAt: "dlt-failed-at",
} as const;

/** What the consumer knows at the moment it gives up. */
export interface DeadLetterContext {
  readonly groupId: string;
  readonly reason: DeadLetterReason;
  readonly attempts: number;
  readonly error: unknown;
  readonly failedAt: Date;
}

/**
 * A header value long enough to diagnose from and short enough to send.
 *
 * Kafka counts headers against `message.max.bytes`, so an unbounded error
 * message — a stack trace, or a driver error quoting the whole statement — can
 * make the record that reports a failure fail to produce, which loses the
 * message the topic exists to keep. 500 matches the outbox's `lastError` column
 * for the same reason.
 */
const ERROR_LIMIT = 500;

/**
 * The dead-letter copy of a message.
 *
 * Three things are preserved deliberately.
 *
 * **The value, byte for byte.** Re-encoding it would defeat the point for the
 * `undecodable` case, where the bytes are the evidence and this build has
 * already proven it cannot parse them.
 *
 * **The key.** Which means the dead-letter topic partitions by aggregate exactly
 * as the source topic does: a user's failed events stay in order relative to
 * each other, and — when both topics have the same partition count, which
 * `MessagingLifecycle` ensures — land on the same partition number, so a redrive
 * does not move a key across partitions and reorder it against its own history.
 *
 * **The producer's headers.** `event-name`, `event-id` and `correlation-id` are
 * how a dead letter is traced back to the request that produced it. A message
 * that already carries `dlt-` headers — one that was redriven and failed
 * again — has them overwritten rather than accumulated, so the header set always
 * describes the most recent failure and the origin coordinates always point at
 * the topic it would be redriven to next.
 */
export function toDeadLetterMessage(
  topic: string,
  message: IncomingMessage,
  context: DeadLetterContext,
): OutgoingMessage {
  return {
    topic,
    key: message.key,
    value: message.value,
    headers: {
      ...message.headers,
      [DEAD_LETTER_HEADERS.reason]: context.reason,
      [DEAD_LETTER_HEADERS.error]: truncate(describeError(context.error)),
      [DEAD_LETTER_HEADERS.errorType]: errorTypeOf(context.error),
      [DEAD_LETTER_HEADERS.attempts]: context.attempts.toString(),
      [DEAD_LETTER_HEADERS.group]: context.groupId,
      [DEAD_LETTER_HEADERS.originTopic]: message.topic,
      [DEAD_LETTER_HEADERS.originPartition]: message.partition.toString(),
      [DEAD_LETTER_HEADERS.originOffset]: message.offset,
      [DEAD_LETTER_HEADERS.failedAt]: context.failedAt.toISOString(),
    },
  };
}

/** The default dead-letter topic for a source topic, when none is configured. */
export function defaultDeadLetterTopic(sourceTopic: string): string {
  return `${sourceTopic}.dlt`;
}

export function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function errorTypeOf(error: unknown): string {
  // `constructor.name` rather than `name`, because `Error.prototype.name` is a
  // writable property that most of this repository's error classes do set — but
  // a plain `throw { message: "…" }` from a dependency has neither, and the
  // header has to exist either way for a consumer routing on it.
  if (error instanceof Error) return error.constructor.name;
  return typeof error;
}

function truncate(message: string, limit = ERROR_LIMIT): string {
  return message.length <= limit ? message : `${message.slice(0, limit - 1)}…`;
}
