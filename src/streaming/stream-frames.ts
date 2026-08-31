import type { MessageEvent } from "@nestjs/common";
import type { AnyDomainEvent, DomainEvent, DomainEventName } from "@/events";
import { formatCursor } from "./stream-cursor";

/**
 * The frame types this endpoint emits that are *not* domain events.
 *
 * Namespaced under `stream.` so they cannot collide with an event name: the
 * catalogue in `src/events/domain-event.ts` is closed and none of its members
 * uses that prefix, which {@link _NO_CONTROL_NAME_IS_A_DOMAIN_EVENT} below
 * turns into a compile error rather than a convention people remember.
 */
export const STREAM_CONTROL_EVENTS = ["stream.open", "stream.heartbeat", "stream.closing"] as const;

export type StreamControlEvent = (typeof STREAM_CONTROL_EVENTS)[number];

type ControlNameClash = Extract<StreamControlEvent, DomainEventName>;
const _NO_CONTROL_NAME_IS_A_DOMAIN_EVENT: [ControlNameClash] extends [never] ? true : never = true;
void _NO_CONTROL_NAME_IS_A_DOMAIN_EVENT;

/** Why a client's `Last-Event-ID` could not be honoured. `null` when it was. */
export type ResumeGap =
  /** No cursor was sent — a first connection, not a failure. */
  | "no-cursor"
  /** The cursor was not in the form this build issues. */
  | "malformed-cursor"
  /** Issued by a different process: a restart, or another replica. */
  | "epoch-changed"
  /** Older than the replay window still holds. */
  | "buffer-evicted"
  /** Ahead of anything this process has issued. */
  | "cursor-ahead";

/** The body of the `stream.open` frame every connection receives first. */
export interface StreamOpenPayload {
  /** The issuing process's identity, echoed so a client can log which one it reached. */
  readonly epoch: string;
  /** The cursor the stream is starting from. */
  readonly cursor: string;
  /** True when the client sent a cursor and every event after it was replayed. */
  readonly resumed: boolean;
  /** How many buffered events were replayed before live delivery began. */
  readonly replayed: number;
  /**
   * `null` when there is no gap in what the client has seen.
   *
   * Anything else means events may have been missed and the client should
   * refetch whatever state it derives from this stream rather than assume it is
   * merely behind. This is the field that exists because "resumed silently from
   * the wrong place" is worse than "could not resume".
   */
  readonly gap: ResumeGap | null;
}

/** The body of a domain-event frame. */
export interface StreamEventPayload {
  readonly id: string;
  readonly name: DomainEventName;
  readonly occurredAt: string;
  readonly correlationId: string | null;
  readonly payload: DomainEvent["payload"];
}

/**
 * A frame carrying a domain event.
 *
 * The SSE event type is the domain event's own name, so a browser subscribes
 * with `source.addEventListener("user.registered", …)` and never has to
 * demultiplex a `data` field by hand.
 */
export function eventFrame(epoch: string, seq: number, event: AnyDomainEvent): MessageEvent {
  const payload: StreamEventPayload = {
    id: event.id,
    name: event.name,
    occurredAt: event.occurredAt,
    correlationId: event.correlationId,
    payload: event.payload,
  };

  return { type: event.name, id: formatCursor(epoch, seq), data: payload };
}

/** The opening frame: the retry hint, the cursor anchor, and the resume verdict. */
export function openFrame(
  epoch: string,
  seq: number,
  retryHintMs: number,
  payload: Omit<StreamOpenPayload, "epoch" | "cursor">,
): MessageEvent {
  const body: StreamOpenPayload = {
    epoch,
    cursor: formatCursor(epoch, seq),
    ...payload,
  };

  // `retry` rides on this frame rather than on its own, because it is the one
  // field that must reach the client before anything can go wrong: it sets how
  // long `EventSource` waits before reconnecting, and the default is 3s in
  // every browser, which during a rolling deploy is every disconnected client
  // returning at once.
  return { type: "stream.open", id: body.cursor, retry: retryHintMs, data: body };
}

/**
 * The keep-alive, which is deliberately invisible to clients.
 *
 * It carries an `id` and no `data`, and that combination is doing real work.
 * From the "dispatch the event" algorithm of the SSE specification: step 1 sets
 * the connection's last event ID from the `id` buffer, and step 2 returns
 * *without dispatching* when the data buffer is empty. So this frame keeps the
 * socket warm through an idle-timeout proxy and keeps the client's resume
 * position current, while firing no handler and reaching no application code.
 * A heartbeat with a `data` field would instead be delivered to every client,
 * which makes ignoring it part of the wire contract.
 *
 * `seq` is the highest position this connection has *processed*, including
 * events filtered out as not visible to it — advancing past those is correct,
 * since a resume would only filter them out again.
 *
 * Nest cannot emit an SSE comment (`: keep-alive`), the more usual keep-alive:
 * `SseStream` renders `MessageEvent` fields only. This is the equivalent that
 * fits through that API, and unlike a comment it also refreshes the cursor.
 *
 * `data` is `""` rather than absent because Nest's `MessageEvent` requires the
 * property — and an empty string is what produces no `data:` line at all, since
 * `SseStream` writes the field only for a truthy `data`. The two facts have to
 * agree for this frame to stay invisible, so `stream-frames.spec.ts` asserts
 * the rendered bytes rather than the object.
 */
export function heartbeatFrame(epoch: string, seq: number): MessageEvent {
  return { type: "stream.heartbeat", id: formatCursor(epoch, seq), data: "" };
}

/**
 * Sent when the process is shutting down, so a client can tell an orderly
 * withdrawal from a network failure.
 *
 * Visible, unlike the heartbeat: the client is about to be disconnected and
 * should reconnect through the load balancer, and on the next process it will
 * find its cursor's epoch is gone. Saying so is cheaper than letting it work
 * that out from a `stream.open` with a gap.
 */
export function closingFrame(epoch: string, seq: number): MessageEvent {
  return {
    type: "stream.closing",
    id: formatCursor(epoch, seq),
    data: { reason: "shutdown" as const },
  };
}
