import type { AnyDomainEvent, DomainEventName } from "@/events";
import type { StreamEventPayload } from "@/streaming";
import type { RoomName } from "./rooms";

/**
 * The control frames this gateway emits.
 *
 * Namespaced under `realtime.` so they cannot collide with a domain event name,
 * exactly as `stream-frames.ts` namespaces the SSE control frames under
 * `stream.` — and checked the same way, by
 * {@link _NO_CONTROL_NAME_IS_A_DOMAIN_EVENT} below, so a future event called
 * `realtime.error` is a compile error rather than a frame two things answer to.
 */
export const REALTIME_CONTROL_EVENTS = [
  "realtime.welcome",
  "realtime.subscribed",
  "realtime.unsubscribed",
  "realtime.lagged",
  "realtime.error",
  "realtime.closing",
] as const;

export type RealtimeControlEvent = (typeof REALTIME_CONTROL_EVENTS)[number];

type ControlNameClash = Extract<RealtimeControlEvent, DomainEventName>;
const _NO_CONTROL_NAME_IS_A_DOMAIN_EVENT: [ControlNameClash] extends [never] ? true : never = true;
void _NO_CONTROL_NAME_IS_A_DOMAIN_EVENT;

/**
 * Every frame on the wire, in both directions.
 *
 * `{ event, data }` is not a choice this module gets to make: it is the shape
 * `WsAdapter` parses inbound frames into before dispatching to a
 * `@SubscribeMessage` handler. Using the same envelope outbound makes the
 * protocol symmetric and, more usefully, makes a domain event frame indexable
 * by exactly the name a client already subscribes to — the same property the
 * SSE endpoint gets from putting the event name in the `event:` line.
 */
export interface RealtimeFrame<T = unknown> {
  readonly event: RealtimeControlEvent | DomainEventName;
  readonly data: T;
}

/** Why a client's frame was refused. */
export type RealtimeErrorCode =
  /** The frame was not an object with the fields this message requires. */
  | "malformed-payload"
  /** A room name this build does not issue — a bad prefix, or an unknown event name. */
  | "unknown-room"
  /** A well-formed room the caller may not subscribe to. */
  | "forbidden-room"
  /** Joining would take the connection past `WS_MAX_ROOMS_PER_CONNECTION`. */
  | "room-limit-exceeded";

export interface RealtimeWelcomePayload {
  readonly connectionId: string;
  readonly userId: string;
  readonly role: string;
  /** The rooms the connection was placed in without asking. */
  readonly rooms: readonly RoomName[];
  /**
   * How long the server will wait for a pong before assuming the peer is gone.
   * Published so a client can size its own liveness expectations against the
   * server's rather than guessing.
   */
  readonly heartbeatIntervalMs: number;
  /** The per-connection ceilings, so a client can stay inside them by construction. */
  readonly limits: {
    readonly maxRooms: number;
    readonly sendHighWaterMarkBytes: number;
  };
}

export interface RealtimeSubscriptionPayload {
  /** Rooms this frame changed. */
  readonly rooms: readonly RoomName[];
  /** Every room the connection is now in, so a client never has to track deltas. */
  readonly allRooms: readonly RoomName[];
}

export interface RealtimeLaggedPayload {
  /** Frames this connection was not sent while it was over the high-water mark. */
  readonly dropped: number;
  /** ISO-8601 instant the connection first went over. */
  readonly since: string;
  /**
   * Always `true`. Present because the field a client must act on is not the
   * count but the instruction: what was dropped is gone, so refetch whatever
   * state you derive from this stream rather than assuming you are merely
   * behind. It is the same signal `stream.open`'s `gap` carries for SSE.
   */
  readonly refetchRequired: true;
}

export interface RealtimeErrorPayload {
  readonly code: RealtimeErrorCode;
  readonly message: string;
  /** The offending room, when the error was about one. */
  readonly room?: string;
}

export interface RealtimeClosingPayload {
  readonly reason: "shutdown";
}

export function welcomeFrame(
  payload: RealtimeWelcomePayload,
): RealtimeFrame<RealtimeWelcomePayload> {
  return { event: "realtime.welcome", data: payload };
}

export function subscribedFrame(
  rooms: readonly RoomName[],
  total: readonly RoomName[],
): RealtimeFrame<RealtimeSubscriptionPayload> {
  return { event: "realtime.subscribed", data: { rooms, allRooms: total } };
}

export function unsubscribedFrame(
  rooms: readonly RoomName[],
  total: readonly RoomName[],
): RealtimeFrame<RealtimeSubscriptionPayload> {
  return { event: "realtime.unsubscribed", data: { rooms, allRooms: total } };
}

export function laggedFrame(dropped: number, since: Date): RealtimeFrame<RealtimeLaggedPayload> {
  return {
    event: "realtime.lagged",
    data: { dropped, since: since.toISOString(), refetchRequired: true },
  };
}

export function errorFrame(
  code: RealtimeErrorCode,
  message: string,
  room?: string,
): RealtimeFrame<RealtimeErrorPayload> {
  return {
    event: "realtime.error",
    data: room === undefined ? { code, message } : { code, message, room },
  };
}

export function closingFrame(): RealtimeFrame<RealtimeClosingPayload> {
  return { event: "realtime.closing", data: { reason: "shutdown" } };
}

/**
 * A domain event, in the same body the SSE endpoint puts on the wire.
 *
 * `StreamEventPayload` is imported rather than redeclared so the two transports
 * cannot drift: a client that moves from `GET /v1/events/stream` to this
 * gateway changes how it connects and nothing about how it reads an event.
 */
export function domainEventFrame(event: AnyDomainEvent): RealtimeFrame<StreamEventPayload> {
  return {
    event: event.name,
    data: {
      id: event.id,
      name: event.name,
      occurredAt: event.occurredAt,
      correlationId: event.correlationId,
      payload: event.payload,
    },
  };
}
