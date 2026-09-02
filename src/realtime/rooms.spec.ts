import { Role } from "@prisma/client";
import { DOMAIN_EVENT_NAMES, type AnyDomainEvent } from "@/events";
import { isVisibleTo, type StreamAudience } from "@/streaming";
import { canJoin, defaultRoomsFor, eventRoom, parseRoom, roomsFor, userRoom } from "./rooms";

function event<K extends AnyDomainEvent["name"]>(
  name: K,
  payload: Extract<AnyDomainEvent, { name: K }>["payload"],
): AnyDomainEvent {
  return {
    id: `evt-${name}`,
    name,
    occurredAt: "2026-09-02T10:00:00.000Z",
    correlationId: null,
    payload,
  } as AnyDomainEvent;
}

const registered = event("user.registered", {
  userId: "user-1",
  email: "person@example.test",
  name: null,
  provider: null,
});

const deleted = event("user.deleted", { userId: "user-1", email: "person@example.test" });

const owner: StreamAudience = { id: "user-1", role: Role.USER };
const stranger: StreamAudience = { id: "user-2", role: Role.USER };
const admin: StreamAudience = { id: "admin-1", role: Role.ADMIN };

describe("parseRoom", () => {
  it("reads the two room forms this build issues", () => {
    expect(parseRoom("user:user-1")).toBe("user:user-1");
    expect(parseRoom("events:user.registered")).toBe("events:user.registered");
  });

  it("refuses an event room naming an event that is not in the catalogue", () => {
    // The failure this prevents is a subscription that succeeds and then never
    // delivers anything, which is indistinguishable from a broken server.
    expect(parseRoom("events:user.updated")).toBeNull();
    expect(parseRoom("events:")).toBeNull();
  });

  it("refuses anything that is not a room", () => {
    for (const raw of [
      "",
      "user",
      "user:",
      "chat:general",
      ":user-1",
      "user:with space",
      "user:a:b",
      "user:a,b",
      `user:${"x".repeat(129)}`,
      42,
      null,
      undefined,
      { room: "user:user-1" },
    ]) {
      expect(parseRoom(raw)).toBeNull();
    }
  });

  it("accepts a user id at the length limit and refuses one past it", () => {
    expect(parseRoom(`user:${"x".repeat(128)}`)).toBe(`user:${"x".repeat(128)}`);
    expect(parseRoom(`user:${"x".repeat(129)}`)).toBeNull();
  });
});

describe("roomsFor", () => {
  it("routes an event to its subject's room and its event room", () => {
    expect(roomsFor(registered)).toEqual(["user:user-1", "events:user.registered"]);
    expect(roomsFor(deleted)).toEqual(["user:user-1", "events:user.deleted"]);
  });

  it("routes every event in the catalogue somewhere", () => {
    // The compiler already forces the switch to be exhaustive; this catches the
    // other half — a branch that compiles because it returns an empty array.
    for (const name of DOMAIN_EVENT_NAMES) {
      const routed = roomsFor(
        event(name, {
          userId: "user-1",
          email: "person@example.test",
          name: null,
          provider: null,
        } as never),
      );

      expect(routed).toContain(eventRoom(name));
      expect(routed.length).toBeGreaterThan(0);
    }
  });
});

describe("canJoin", () => {
  it("lets a caller into their own room and nobody else's", () => {
    expect(canJoin(owner, userRoom("user-1"))).toBe(true);
    expect(canJoin(owner, userRoom("user-2"))).toBe(false);
  });

  it("refuses a non-administrator the catalogue-wide event rooms", () => {
    expect(canJoin(owner, eventRoom("user.registered"))).toBe(false);
  });

  it("lets an administrator into any room", () => {
    expect(canJoin(admin, userRoom("user-1"))).toBe(true);
    expect(canJoin(admin, eventRoom("user.deleted"))).toBe(true);
  });

  it("never admits an audience to a room whose traffic isVisibleTo would refuse in full", () => {
    // The property that keeps rooms from becoming a second, weaker
    // authorisation path: every room a caller may join is one where at least
    // some of the routed traffic is theirs to see. A room that passed `canJoin`
    // and failed `isVisibleTo` for every event would be a subscription that can
    // only ever deliver silence — and one that failed the other way round would
    // be a leak, which `realtime.gateway.spec.ts` pins from the delivery side.
    for (const audience of [owner, stranger, admin]) {
      for (const domainEvent of [registered, deleted]) {
        for (const room of roomsFor(domainEvent)) {
          if (!canJoin(audience, room)) continue;
          expect(isVisibleTo(domainEvent, audience)).toBe(true);
        }
      }
    }
  });
});

describe("defaultRoomsFor", () => {
  it("places a fresh connection in its own room, so a client needs no opening round trip", () => {
    expect(defaultRoomsFor(owner)).toEqual(["user:user-1"]);
  });
});
