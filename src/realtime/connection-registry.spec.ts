import { Role } from "@prisma/client";
import { FakeRealtimeSocket } from "@/test-utils/fake-realtime-socket";
import { BackpressuredSocket } from "./backpressured-socket";
import { ConnectionRegistry, type RealtimeConnection } from "./connection-registry";
import type { RoomName } from "./rooms";

function connect(
  registry: ConnectionRegistry,
  id: string,
  rooms: RoomName[],
): { socket: FakeRealtimeSocket; connection: RealtimeConnection } {
  const socket = new FakeRealtimeSocket();
  const connection: RealtimeConnection = {
    id,
    audience: { id: `user-${id}`, role: Role.USER },
    writer: new BackpressuredSocket(socket, { highWaterMarkBytes: 1_000, graceMs: 1_000 }),
    rooms: new Set(rooms),
    awaitingPong: false,
  };
  registry.add(socket, connection);
  return { socket, connection };
}

describe("ConnectionRegistry", () => {
  it("indexes a connection into the rooms it arrived with", () => {
    const registry = new ConnectionRegistry();
    const { connection } = connect(registry, "a", ["user:user-a", "events:user.registered"]);

    expect(registry.size).toBe(1);
    expect([...registry.membersOf("user:user-a")]).toEqual([connection]);
    expect([...registry.membersOf("events:user.registered")]).toEqual([connection]);
  });

  it("returns an empty membership for a room nobody is in", () => {
    const registry = new ConnectionRegistry();

    expect(registry.membersOf("events:user.deleted").size).toBe(0);
  });

  it("holds several connections in one room", () => {
    const registry = new ConnectionRegistry();
    const first = connect(registry, "a", ["events:user.registered"]);
    const second = connect(registry, "b", ["events:user.registered"]);

    expect([...registry.membersOf("events:user.registered")]).toEqual([
      first.connection,
      second.connection,
    ]);
  });

  it("reports a join as new only the first time", () => {
    const registry = new ConnectionRegistry();
    const { connection } = connect(registry, "a", []);

    expect(registry.join(connection, "events:user.deleted")).toBe(true);
    expect(registry.join(connection, "events:user.deleted")).toBe(false);
    expect(registry.membersOf("events:user.deleted").size).toBe(1);
  });

  it("reports a leave as a change only when the connection was in the room", () => {
    const registry = new ConnectionRegistry();
    const { connection } = connect(registry, "a", ["user:user-a"]);

    expect(registry.leave(connection, "user:user-a")).toBe(true);
    expect(registry.leave(connection, "user:user-a")).toBe(false);
    expect(connection.rooms.size).toBe(0);
  });

  it("forgets a room once its last member leaves", () => {
    // A process that has seen a million user rooms must not be holding a
    // million empty sets.
    const registry = new ConnectionRegistry();
    const first = connect(registry, "a", ["user:shared"]);
    const second = connect(registry, "b", ["user:shared"]);

    registry.leave(first.connection, "user:shared");
    expect(registry.roomCount).toBe(1);

    registry.leave(second.connection, "user:shared");
    expect(registry.roomCount).toBe(0);
  });

  it("takes a disconnecting socket out of every room it was in", () => {
    const registry = new ConnectionRegistry();
    const { socket, connection } = connect(registry, "a", [
      "user:user-a",
      "events:user.registered",
      "events:user.deleted",
    ]);

    expect(registry.remove(socket)).toBe(connection);

    expect(registry.size).toBe(0);
    expect(registry.roomCount).toBe(0);
    expect(registry.get(socket)).toBeUndefined();
  });

  it("is silent about a socket it never admitted", () => {
    // The unauthenticated case: a socket closed during the handshake still
    // fires `close`, and the gateway looks it up regardless.
    const registry = new ConnectionRegistry();

    expect(registry.remove(new FakeRealtimeSocket())).toBeUndefined();
  });

  it("leaves other connections' memberships alone when one disconnects", () => {
    const registry = new ConnectionRegistry();
    const staying = connect(registry, "a", ["events:user.registered"]);
    const leaving = connect(registry, "b", ["events:user.registered"]);

    registry.remove(leaving.socket);

    expect([...registry.membersOf("events:user.registered")]).toEqual([staying.connection]);
    expect([...registry.connections()]).toEqual([staying.connection]);
  });
});
