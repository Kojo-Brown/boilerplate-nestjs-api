import { DOMAIN_EVENT_NAMES, type AnyDomainEvent } from "@/events";
import {
  REALTIME_CONTROL_EVENTS,
  closingFrame,
  domainEventFrame,
  errorFrame,
  laggedFrame,
  subscribedFrame,
  unsubscribedFrame,
  welcomeFrame,
} from "./realtime-frames";

const registered: AnyDomainEvent = {
  id: "evt-1",
  name: "user.registered",
  occurredAt: "2026-09-02T10:00:00.000Z",
  correlationId: "req-9",
  payload: { userId: "user-1", email: "person@example.test", name: "Ada", provider: null },
};

describe("realtime frames", () => {
  it("names a domain-event frame after the event, so a client indexes on what it subscribed to", () => {
    expect(domainEventFrame(registered)).toEqual({
      event: "user.registered",
      data: {
        id: "evt-1",
        name: "user.registered",
        occurredAt: "2026-09-02T10:00:00.000Z",
        correlationId: "req-9",
        payload: { userId: "user-1", email: "person@example.test", name: "Ada", provider: null },
      },
    });
  });

  it("keeps every control frame out of the domain event namespace", () => {
    // The compile-time check in the module makes a collision an error; this
    // asserts the runtime list it is checked against has not been let slip.
    for (const control of REALTIME_CONTROL_EVENTS) {
      expect(DOMAIN_EVENT_NAMES).not.toContain(control);
      expect(control.startsWith("realtime.")).toBe(true);
    }
  });

  it("publishes the connection's limits in the welcome frame", () => {
    const frame = welcomeFrame({
      connectionId: "conn-1",
      userId: "user-1",
      role: "USER",
      rooms: ["user:user-1"],
      heartbeatIntervalMs: 30_000,
      limits: { maxRooms: 64, sendHighWaterMarkBytes: 1_048_576 },
    });

    expect(frame.event).toBe("realtime.welcome");
    expect(frame.data.limits).toEqual({ maxRooms: 64, sendHighWaterMarkBytes: 1_048_576 });
  });

  it("reports the whole membership alongside the delta on a subscription change", () => {
    // A client that only ever received deltas would have to reconstruct its own
    // membership, and the two would drift on the first dropped frame.
    expect(
      subscribedFrame(["events:user.deleted"], ["user:user-1", "events:user.deleted"]),
    ).toEqual({
      event: "realtime.subscribed",
      data: {
        rooms: ["events:user.deleted"],
        allRooms: ["user:user-1", "events:user.deleted"],
      },
    });

    expect(unsubscribedFrame(["events:user.deleted"], ["user:user-1"])).toEqual({
      event: "realtime.unsubscribed",
      data: { rooms: ["events:user.deleted"], allRooms: ["user:user-1"] },
    });
  });

  it("tells a recovered client to refetch rather than to count", () => {
    const frame = laggedFrame(12, new Date("2026-09-02T10:00:00.000Z"));

    expect(frame).toEqual({
      event: "realtime.lagged",
      data: { dropped: 12, since: "2026-09-02T10:00:00.000Z", refetchRequired: true },
    });
  });

  it("omits the room from an error that is not about one", () => {
    expect(errorFrame("malformed-payload", "bad frame")).toEqual({
      event: "realtime.error",
      data: { code: "malformed-payload", message: "bad frame" },
    });

    expect(errorFrame("forbidden-room", "no", "user:someone-else")).toEqual({
      event: "realtime.error",
      data: { code: "forbidden-room", message: "no", room: "user:someone-else" },
    });
  });

  it("says a shutdown was a shutdown", () => {
    expect(closingFrame()).toEqual({ event: "realtime.closing", data: { reason: "shutdown" } });
  });
});
