import type { JwtService } from "@nestjs/jwt";
import { Role } from "@prisma/client";
import type { IncomingMessage } from "http";
import type { WebSocket } from "ws";
import { DOMAIN_EVENT_NAMES, type DomainEvent } from "@/events";
import { FakeRealtimeSocket } from "@/test-utils/fake-realtime-socket";
import { stubConfig } from "@/test-utils/stub-config";
import { RealtimeCloseCode } from "./close-codes";
import { RealtimeGateway } from "./realtime.gateway";

const HEARTBEAT_MS = 30_000;
const HIGH_WATER = 1_000;

const SETTINGS = {
  WS_MAX_CONNECTIONS: 3,
  WS_MAX_ROOMS_PER_CONNECTION: 4,
  WS_SEND_HIGH_WATER_MARK_BYTES: HIGH_WATER,
  WS_SLOW_CONSUMER_GRACE_MS: 10_000,
  WS_HEARTBEAT_INTERVAL_MS: HEARTBEAT_MS,
};

/**
 * Tokens are the user id, so a spec reads `connect("user-1")` rather than
 * carrying a signing key around. The verifier below is what
 * `authenticateHandshake` calls, and `handshake.spec.ts` covers what it does
 * with a real one.
 */
function jwtStub(roles: Record<string, Role> = {}): JwtService {
  return {
    verify(token: string): unknown {
      if (token.startsWith("bad-")) throw new Error("invalid signature");
      if (token === "not-an-access-token") return { iss: "someone" };
      return { sub: token, email: `${token}@example.test`, role: roles[token] ?? Role.USER };
    },
  } as unknown as JwtService;
}

function upgradeRequest(token: string | null): IncomingMessage {
  return {
    url: "/v1/realtime",
    headers: token === null ? {} : { authorization: `Bearer ${token}` },
  } as unknown as IncomingMessage;
}

function build(roles?: Record<string, Role>) {
  const gateway = new RealtimeGateway(stubConfig(SETTINGS), jwtStub(roles));

  const connect = (token: string | null): FakeRealtimeSocket => {
    const socket = new FakeRealtimeSocket();
    gateway.handleConnection(socket as unknown as WebSocket, upgradeRequest(token));
    return socket;
  };

  const subscribe = (socket: FakeRealtimeSocket, body: unknown): void => {
    gateway.handleSubscribe(socket as unknown as WebSocket, body);
  };

  const unsubscribe = (socket: FakeRealtimeSocket, body: unknown): void => {
    gateway.handleUnsubscribe(socket as unknown as WebSocket, body);
  };

  const disconnect = (socket: FakeRealtimeSocket): void => {
    gateway.handleDisconnect(socket as unknown as WebSocket);
  };

  return { gateway, connect, subscribe, unsubscribe, disconnect };
}

function registered(userId: string): DomainEvent<"user.registered"> {
  return {
    id: `evt-${userId}`,
    name: "user.registered",
    occurredAt: "2026-09-02T10:00:00.000Z",
    correlationId: null,
    payload: { userId, email: `${userId}@example.test`, name: null, provider: null },
  };
}

function deleted(userId: string): DomainEvent<"user.deleted"> {
  return {
    id: `evt-del-${userId}`,
    name: "user.deleted",
    occurredAt: "2026-09-02T10:00:00.000Z",
    correlationId: null,
    payload: { userId, email: `${userId}@example.test` },
  };
}

describe("RealtimeGateway — handshake", () => {
  it("admits a verified socket, places it in its own room and says so", () => {
    const { gateway, connect } = build();

    const socket = connect("user-1");

    expect(gateway.openConnections).toBe(1);
    expect(socket.closed).toBeNull();
    expect(socket.lastFrame()).toMatchObject({
      event: "realtime.welcome",
      data: {
        userId: "user-1",
        role: Role.USER,
        rooms: ["user:user-1"],
        heartbeatIntervalMs: HEARTBEAT_MS,
        limits: { maxRooms: 4, sendHighWaterMarkBytes: HIGH_WATER },
      },
    });
  });

  it("closes a socket with no credentials, with the code a browser can read", () => {
    const { gateway, connect } = build();

    const socket = connect(null);

    expect(gateway.openConnections).toBe(0);
    expect(socket.closed).toEqual({
      code: RealtimeCloseCode.UNAUTHENTICATED,
      reason: "missing-credentials",
    });
    expect(socket.sent).toEqual([]);
  });

  it("closes a socket whose token does not verify", () => {
    const { connect } = build();

    expect(connect("bad-token").closed).toMatchObject({
      code: RealtimeCloseCode.UNAUTHENTICATED,
      reason: "invalid-token",
    });
  });

  it("distinguishes a token this service signed that is not an access token", () => {
    // 4403 rather than 4401, because retrying with the same credential cannot
    // help — it is the wrong artefact, not an expired one.
    expect(build().connect("not-an-access-token").closed).toMatchObject({
      code: RealtimeCloseCode.FORBIDDEN,
      reason: "unexpected-claims",
    });
  });

  it("refuses connections past the cap", () => {
    const { gateway, connect } = build();

    connect("user-1");
    connect("user-2");
    connect("user-3");
    const refused = connect("user-4");

    expect(gateway.openConnections).toBe(3);
    expect(refused.closed).toEqual({ code: RealtimeCloseCode.AT_CAPACITY, reason: "at capacity" });
  });

  it("does not count a rejected handshake against the cap", () => {
    // The reason authentication runs before the capacity check: otherwise
    // anyone who can reach the port can exhaust a paying client's budget.
    const { gateway, connect } = build();

    for (let i = 0; i < 50; i += 1) connect("bad-token");

    expect(gateway.openConnections).toBe(0);
    expect(connect("user-1").closed).toBeNull();
  });

  it("frees the slot when the socket disconnects", () => {
    const { gateway, connect, disconnect } = build();

    const socket = connect("user-1");
    disconnect(socket);

    expect(gateway.openConnections).toBe(0);
  });

  it("ignores a disconnect for a socket it never admitted", () => {
    const { gateway, connect, disconnect } = build();

    disconnect(connect(null));

    expect(gateway.openConnections).toBe(0);
  });
});

describe("RealtimeGateway — rooms", () => {
  it("joins a room an administrator is allowed into and reports the whole membership", () => {
    const { connect, subscribe } = build({ "admin-1": Role.ADMIN });

    const socket = connect("admin-1");
    subscribe(socket, { rooms: ["events:user.registered"] });

    expect(socket.lastFrame()).toEqual({
      event: "realtime.subscribed",
      data: {
        rooms: ["events:user.registered"],
        allRooms: ["user:admin-1", "events:user.registered"],
      },
    });
  });

  it("refuses a room the caller may not have, without joining any of the frame", () => {
    const { connect, subscribe } = build();

    const socket = connect("user-1");
    subscribe(socket, { rooms: ["user:user-1", "user:user-2"] });

    expect(socket.lastFrame()).toEqual({
      event: "realtime.error",
      data: {
        code: "forbidden-room",
        message: "This account may not subscribe to that room.",
        room: "user:user-2",
      },
    });
  });

  it("refuses a room name this build does not issue", () => {
    const { connect, subscribe } = build();

    const socket = connect("user-1");
    subscribe(socket, { rooms: ["events:user.updated"] });

    expect(socket.lastFrame()).toMatchObject({
      event: "realtime.error",
      data: { code: "unknown-room", room: "events:user.updated" },
    });
  });

  it("refuses a frame that is not a room request", () => {
    const { connect, subscribe } = build();
    const socket = connect("user-1");

    for (const body of [undefined, null, "user:user-1", { rooms: "user:user-1" }, []]) {
      subscribe(socket, body);
      expect(socket.lastFrame()).toMatchObject({
        event: "realtime.error",
        data: { code: "malformed-payload" },
      });
    }
  });

  it("refuses an empty room list", () => {
    const { connect, subscribe } = build();

    const socket = connect("user-1");
    subscribe(socket, { rooms: [] });

    expect(socket.lastFrame()).toMatchObject({
      event: "realtime.error",
      data: { code: "malformed-payload" },
    });
  });

  it("holds a connection to its room ceiling", () => {
    // The bound that keeps an administrator — who may join any `user:<id>`
    // room — from making the registry allocate a key per frame.
    const { connect, subscribe } = build({ "admin-1": Role.ADMIN });

    const socket = connect("admin-1");
    subscribe(socket, { rooms: ["user:a", "user:b", "user:c"] });
    expect(socket.lastFrame()?.event).toBe("realtime.subscribed");

    subscribe(socket, { rooms: ["user:d"] });
    expect(socket.lastFrame()).toMatchObject({
      event: "realtime.error",
      data: { code: "room-limit-exceeded" },
    });
  });

  it("counts a room the connection is already in only once against the ceiling", () => {
    const { connect, subscribe } = build({ "admin-1": Role.ADMIN });

    const socket = connect("admin-1");
    subscribe(socket, { rooms: ["user:a", "user:b", "user:c"] });
    subscribe(socket, { rooms: ["user:a", "user:b"] });

    expect(socket.lastFrame()).toEqual({
      event: "realtime.subscribed",
      data: { rooms: [], allRooms: ["user:admin-1", "user:a", "user:b", "user:c"] },
    });
  });

  it("lets a connection leave a room it may no longer join", () => {
    // Leaving is unconditional on purpose: a membership a role change has made
    // unjoinable must still be escapable without reconnecting.
    const { connect, subscribe, unsubscribe } = build({ "admin-1": Role.ADMIN });

    const socket = connect("admin-1");
    subscribe(socket, { rooms: ["events:user.deleted"] });
    unsubscribe(socket, { rooms: ["events:user.deleted"] });

    expect(socket.lastFrame()).toEqual({
      event: "realtime.unsubscribed",
      data: { rooms: ["events:user.deleted"], allRooms: ["user:admin-1"] },
    });
  });

  it("reports a repeated leave once rather than as an error", () => {
    const { connect, unsubscribe } = build();

    const socket = connect("user-1");
    unsubscribe(socket, { rooms: ["user:user-1", "user:user-1"] });

    expect(socket.lastFrame()).toEqual({
      event: "realtime.unsubscribed",
      data: { rooms: ["user:user-1"], allRooms: [] },
    });
  });

  it("ignores a message from a socket that was never admitted", () => {
    const { connect, subscribe } = build();

    const socket = connect(null);
    socket.sent.length = 0;
    subscribe(socket, { rooms: ["user:user-1"] });

    expect(socket.sent).toEqual([]);
  });
});

describe("RealtimeGateway — delivery", () => {
  it("delivers an event to its subject and to nobody else", () => {
    const { gateway, connect } = build();

    const subject = connect("user-1");
    const bystander = connect("user-2");
    subject.sent.length = 0;
    bystander.sent.length = 0;

    gateway.onUserRegistered(registered("user-1"));

    expect(subject.lastFrame()).toEqual({
      event: "user.registered",
      data: {
        id: "evt-user-1",
        name: "user.registered",
        occurredAt: "2026-09-02T10:00:00.000Z",
        correlationId: null,
        payload: {
          userId: "user-1",
          email: "user-1@example.test",
          name: null,
          provider: null,
        },
      },
    });
    expect(bystander.sent).toEqual([]);
  });

  it("delivers a deletion to its subject", () => {
    const { gateway, connect } = build();

    const socket = connect("user-1");
    socket.sent.length = 0;
    gateway.onUserDeleted(deleted("user-1"));

    expect(socket.lastFrame()).toMatchObject({ event: "user.deleted" });
  });

  it("sends one copy to an administrator who is in both rooms an event routes to", () => {
    const { gateway, connect, subscribe } = build({ "admin-1": Role.ADMIN });

    const socket = connect("admin-1");
    subscribe(socket, { rooms: ["events:user.registered"] });
    socket.sent.length = 0;

    gateway.onUserRegistered(registered("admin-1"));

    expect(socket.eventNames()).toEqual(["user.registered"]);
  });

  it("gives an administrator the whole catalogue once they subscribe to it", () => {
    const { gateway, connect, subscribe } = build({ "admin-1": Role.ADMIN });

    const socket = connect("admin-1");
    subscribe(socket, { rooms: ["events:user.registered"] });
    socket.sent.length = 0;

    gateway.onUserRegistered(registered("someone-else"));

    expect(socket.eventNames()).toEqual(["user.registered"]);
  });

  it("writes nothing isVisibleTo would refuse, whatever rooms were joined", () => {
    // The guarantee the room model rests on. A non-administrator cannot join
    // another account's room, so this drives the check from the other side:
    // membership is forced directly into the registry, and delivery still
    // refuses. Rooms decide what is considered; `isVisibleTo` decides what is
    // written.
    const { gateway, connect } = build();

    const socket = connect("user-1");
    const connection = [...gateway["registry"].connections()][0];
    gateway["registry"].join(connection!, "events:user.registered");
    gateway["registry"].join(connection!, "user:user-2");
    socket.sent.length = 0;

    gateway.onUserRegistered(registered("user-2"));

    expect(socket.sent).toEqual([]);
  });

  it("does not deliver to a connection that has disconnected", () => {
    const { gateway, connect, disconnect } = build();

    const socket = connect("user-1");
    disconnect(socket);
    socket.sent.length = 0;

    gateway.onUserRegistered(registered("user-1"));

    expect(socket.sent).toEqual([]);
  });

  it("drops an event for a peer that is over its high-water mark, and keeps serving the rest", () => {
    const { gateway, connect } = build();

    const slow = connect("user-1");
    const healthy = connect("user-2");
    slow.bufferedAmount = HIGH_WATER + 1;
    slow.sent.length = 0;
    healthy.sent.length = 0;

    gateway.onUserRegistered(registered("user-1"));
    gateway.onUserRegistered(registered("user-2"));

    expect(slow.sent).toEqual([]);
    expect(healthy.eventNames()).toEqual(["user.registered"]);
  });
});

describe("RealtimeGateway — liveness and shutdown", () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it("pings every connection on the sweep and terminates one that never answers", () => {
    const { gateway, connect } = build();
    gateway.onApplicationBootstrap();

    const answering = connect("user-1");
    const silent = connect("user-2");

    jest.advanceTimersByTime(HEARTBEAT_MS);
    expect(answering.pings).toHaveLength(1);
    expect(silent.pings).toHaveLength(1);

    answering.pong();

    jest.advanceTimersByTime(HEARTBEAT_MS);
    expect(silent.terminated).toBe(true);
    expect(answering.terminated).toBe(false);
    expect(answering.pings).toHaveLength(2);

    gateway.beforeApplicationShutdown();
  });

  it("stops sweeping once the process is shutting down", () => {
    const { gateway, connect } = build();
    gateway.onApplicationBootstrap();
    const socket = connect("user-1");

    gateway.beforeApplicationShutdown();
    socket.sent.length = 0;
    jest.advanceTimersByTime(HEARTBEAT_MS * 5);

    expect(socket.pings).toHaveLength(0);
  });

  it("says goodbye before the socket module terminates every client", () => {
    const { gateway, connect } = build();
    const socket = connect("user-1");
    socket.sent.length = 0;

    gateway.beforeApplicationShutdown();

    expect(socket.eventNames()).toEqual(["realtime.closing"]);
    expect(socket.closed).toEqual({
      code: RealtimeCloseCode.GOING_AWAY,
      reason: "server shutting down",
    });
  });

  it("says goodbye even to a connection that is behind", () => {
    const { gateway, connect } = build();
    const socket = connect("user-1");
    socket.bufferedAmount = HIGH_WATER * 100;
    socket.sent.length = 0;

    gateway.beforeApplicationShutdown();

    expect(socket.eventNames()).toEqual(["realtime.closing"]);
  });

  it("is a no-op when nothing is connected", () => {
    const { gateway } = build();

    expect(() => gateway.beforeApplicationShutdown()).not.toThrow();
  });
});

describe("RealtimeGateway — event catalogue", () => {
  it("subscribes to every event in the catalogue", () => {
    // Adding an event to `DomainEventPayloads` breaks `roomsFor` and
    // `isVisibleTo` at compile time, but nothing makes anyone *subscribe* to
    // it. Without this, a new event would reach the SSE stream and not this
    // gateway, and the two transports would quietly deliver different things.
    //
    // `EVENT_LISTENER_METADATA` is the key `@OnEvent` — which `@OnDomainEvent`
    // wraps — writes on the decorated method. Read by its literal value rather
    // than imported from `@nestjs/event-emitter/dist`, which is not a public
    // entry point; the constant has been that string since v1 and the
    // assertion below fails loudly if it ever is not.
    const prototype: object = RealtimeGateway.prototype;
    const subscribed = Object.getOwnPropertyNames(prototype)
      .map((method) => Object.getOwnPropertyDescriptor(prototype, method)?.value as unknown)
      .filter((fn): fn is object => typeof fn === "function")
      .flatMap(
        (fn) => (Reflect.getMetadata("EVENT_LISTENER_METADATA", fn) ?? []) as { event: string }[],
      )
      .map((listener) => listener.event);

    expect(subscribed.length).toBeGreaterThan(0);
    expect([...subscribed].sort()).toEqual([...DOMAIN_EVENT_NAMES].sort());
  });
});
