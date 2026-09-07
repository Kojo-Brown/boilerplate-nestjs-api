import { Role } from "@prisma/client";
import { isDomainEventName, type AnyDomainEvent, type DomainEventName } from "@/events";
import type { StreamAudience } from "@/streaming";

/** Every event about one account. */
export type UserRoom = `user:${string}`;
/** Every occurrence of one event name, across all accounts. */
export type EventRoom = `events:${DomainEventName}`;

export type RoomName = UserRoom | EventRoom;

/**
 * The longest user id a room name may carry.
 *
 * Room names are map keys held for the life of a connection, and an
 * administrator may join a room for any account — so without a bound, a client
 * with a valid admin token can make this process allocate a distinct key per
 * `subscribe` frame until it runs out of memory. `WS_MAX_ROOMS_PER_CONNECTION`
 * bounds how many; this bounds how large each may be. Prisma's `cuid()` ids are
 * 25 characters and a UUID is 36, so the limit is generous by a factor of three
 * and still finite.
 */
const MAX_USER_ID_LENGTH = 128;

export function userRoom(userId: string): UserRoom {
  return `user:${userId}`;
}

export function eventRoom(name: DomainEventName): EventRoom {
  return `events:${name}`;
}

/**
 * Reads a room name off the wire, or refuses it.
 *
 * `null` rather than a thrown error: the caller is a message handler answering
 * an untrusted frame, and every rejection there is a `realtime.error` reply
 * rather than an exception. Unknown event names are refused here rather than
 * accepted as an empty room, so a client that subscribes to `events:user.updated`
 * after that event is renamed learns immediately instead of waiting forever for
 * traffic that will never arrive.
 */
export function parseRoom(raw: unknown): RoomName | null {
  if (typeof raw !== "string") return null;

  const separator = raw.indexOf(":");
  if (separator === -1) return null;

  const prefix = raw.slice(0, separator);
  const rest = raw.slice(separator + 1);

  if (prefix === "user") {
    if (rest === "" || rest.length > MAX_USER_ID_LENGTH) return null;
    // Room names are also log lines and map keys; anything with whitespace or a
    // separator in it is not an id this system issues.
    if (/[\s:,]/.test(rest)) return null;
    return userRoom(rest);
  }

  if (prefix === "events") {
    return isDomainEventName(rest) ? eventRoom(rest) : null;
  }

  return null;
}

/**
 * The rooms one event is delivered to.
 *
 * Exhaustive over the catalogue for the same reason
 * {@link import("@/streaming").isVisibleTo} is: adding an event to
 * `DomainEventPayloads` stops this file compiling until somebody says where it
 * is routed, rather than defaulting it to a room nobody is in — which is the
 * failure that looks exactly like a working system until the support ticket
 * arrives.
 */
export function roomsFor(event: AnyDomainEvent): readonly RoomName[] {
  switch (event.name) {
    case "user.registered":
      return [userRoom(event.payload.userId), eventRoom(event.name)];
    case "user.deleted":
      return [userRoom(event.payload.userId), eventRoom(event.name)];
    case "order.placed":
    case "order.confirmed":
    case "order.cancelled":
      // The customer's room, not an order room. A room is held for the life of
      // a connection, and a client that had to join a room per order would have
      // to know the id before the order exists — which is exactly the event it
      // is waiting for.
      return [userRoom(event.payload.userId), eventRoom(event.name)];
    default: {
      const unhandled: never = event;
      void unhandled;
      return [];
    }
  }
}

/**
 * Whether a caller may subscribe to a room.
 *
 * **A room is an interest filter, never a permission.** That sentence is the
 * design of this module. Membership decides which connections a fan-out has to
 * *consider*; whether a given event may actually be written to one of them is
 * decided, every time, by `isVisibleTo` — the same function the SSE endpoint
 * uses, with the same exhaustive switch over the catalogue. Two authorisation
 * paths that must agree are two authorisation paths that eventually will not,
 * and the one that drifts is always the newer one.
 *
 * So what is this for? Two things that are not authorisation. It keeps the
 * registry's reverse index from filling with rooms whose traffic the subscriber
 * could never be shown, and it turns "subscribed successfully, then silence"
 * — the single most confusing failure a pub/sub client can hit — into an
 * immediate, specific error. `realtime.spec.ts` pins the relationship the other
 * way round: for every event in the catalogue and every audience, nothing
 * reaches a socket that `isVisibleTo` would refuse, whatever rooms it joined.
 *
 * The rule mirrors `isVisibleTo`'s: administrators see the whole catalogue,
 * everyone else sees only their own account.
 */
export function canJoin(audience: StreamAudience, room: RoomName): boolean {
  if (audience.role === Role.ADMIN) return true;
  return room === userRoom(audience.id);
}

/** The rooms a connection is placed in before it asks for anything. */
export function defaultRoomsFor(audience: StreamAudience): readonly RoomName[] {
  // Its own. A client that connects and subscribes to nothing still wants to
  // hear about itself, and making that the default removes the round trip that
  // every client would otherwise open with.
  return [userRoom(audience.id)];
}
