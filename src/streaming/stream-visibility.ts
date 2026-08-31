import { Role } from "@prisma/client";
import type { AnyDomainEvent } from "@/events";
import type { AuthenticatedUser } from "@/auth/strategies/jwt.strategy";

/** Who a connection belongs to. The subset of the JWT subject this module reads. */
export type StreamAudience = Pick<AuthenticatedUser, "id" | "role">;

/**
 * Whether one connection is allowed to see one event.
 *
 * This exists because the alternative is a data leak, not because it is
 * tidy. `DomainEventBus` carries every event in the process, and
 * `user.registered` carries an email address — so an endpoint that fanned the
 * bus out to every authenticated caller would hand each of them the address of
 * everybody who signs up, in real time, from a route whose only stated job is
 * "stream events". Broadcast is the default an event stream invites, and it is
 * the wrong one for a bus whose payloads were written for in-process
 * subscribers rather than for clients.
 *
 * The rule is: administrators see the whole catalogue, everyone else sees only
 * events about themselves.
 *
 * The `switch` is exhaustive against the event catalogue, and deliberately so.
 * Adding an event to `DomainEventPayloads` stops this file compiling until
 * somebody decides who may see it — the decision is then made once, here, by a
 * person, rather than defaulted to "everyone" by an `if` that did not mention
 * the new name. Defaulting the other way (deny) would be safe but silent: a new
 * event would simply never appear on the stream and the omission would surface
 * as a support ticket months later.
 */
export function isVisibleTo(event: AnyDomainEvent, audience: StreamAudience): boolean {
  if (audience.role === Role.ADMIN) return true;

  switch (event.name) {
    case "user.registered":
      return event.payload.userId === audience.id;
    case "user.deleted":
      // Reachable: the token outlives the row, so the deleted user's own
      // connection stays open and authenticated until the JWT expires. Telling
      // them their account is gone is the one thing this event is good for.
      return event.payload.userId === audience.id;
    default: {
      const unhandled: never = event;
      void unhandled;
      return false;
    }
  }
}
