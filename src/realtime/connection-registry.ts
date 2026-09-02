import type { StreamAudience } from "@/streaming";
import type { BackpressuredSocket } from "./backpressured-socket";
import type { RealtimeSocket } from "./ports";
import type { RoomName } from "./rooms";

/** One authenticated socket, and everything the gateway knows about it. */
export interface RealtimeConnection {
  /** Minted per connection. Appears in the welcome frame and in every log line about it. */
  readonly id: string;
  readonly audience: StreamAudience;
  readonly writer: BackpressuredSocket;
  readonly rooms: Set<RoomName>;
  /**
   * Cleared when a ping is sent and set again when the pong arrives.
   *
   * Still false at the next sweep means the peer did not answer a full interval
   * — a half-open connection, which is invisible at the application layer and
   * would otherwise hold its slot until the operating system gave up on the
   * TCP connection, which can be hours.
   */
  awaitingPong: boolean;
}

const NO_MEMBERS: ReadonlySet<RealtimeConnection> = new Set();

/**
 * Who is connected, and who is in which room.
 *
 * The reverse index from room to members is the entire reason rooms exist as a
 * concept rather than as a filter predicate. Without it, delivering one
 * `user.registered` means walking every open connection and asking each whether
 * it cares — O(connections) per event, on a process holding a thousand of them,
 * for an event that concerns exactly one. With it, delivery is O(members of the
 * rooms the event routes to), which for a per-user event is one.
 *
 * Both directions are maintained together because either alone is a leak. The
 * forward set on {@link RealtimeConnection} is what makes disconnect cleanup
 * O(rooms this connection joined) instead of a scan of every room in the
 * process; the reverse index is what makes delivery fast. A room whose last
 * member leaves is deleted rather than left empty, so a long-lived process that
 * has seen a million user rooms holds none of them.
 */
export class ConnectionRegistry {
  private readonly bySocket = new Map<RealtimeSocket, RealtimeConnection>();
  private readonly byRoom = new Map<RoomName, Set<RealtimeConnection>>();

  get size(): number {
    return this.bySocket.size;
  }

  get roomCount(): number {
    return this.byRoom.size;
  }

  add(socket: RealtimeSocket, connection: RealtimeConnection): void {
    this.bySocket.set(socket, connection);
    for (const room of connection.rooms) this.index(room, connection);
  }

  get(socket: RealtimeSocket): RealtimeConnection | undefined {
    return this.bySocket.get(socket);
  }

  /** Forgets a socket and takes it out of every room it was in. */
  remove(socket: RealtimeSocket): RealtimeConnection | undefined {
    const connection = this.bySocket.get(socket);
    if (!connection) return undefined;

    this.bySocket.delete(socket);
    for (const room of connection.rooms) this.deindex(room, connection);
    connection.rooms.clear();
    return connection;
  }

  /** `true` when the connection was not already in the room. */
  join(connection: RealtimeConnection, room: RoomName): boolean {
    if (connection.rooms.has(room)) return false;
    connection.rooms.add(room);
    this.index(room, connection);
    return true;
  }

  /** `true` when the connection was in the room. */
  leave(connection: RealtimeConnection, room: RoomName): boolean {
    if (!connection.rooms.delete(room)) return false;
    this.deindex(room, connection);
    return true;
  }

  membersOf(room: RoomName): ReadonlySet<RealtimeConnection> {
    return this.byRoom.get(room) ?? NO_MEMBERS;
  }

  connections(): IterableIterator<RealtimeConnection> {
    return this.bySocket.values();
  }

  private index(room: RoomName, connection: RealtimeConnection): void {
    const members = this.byRoom.get(room);
    if (members) {
      members.add(connection);
      return;
    }
    this.byRoom.set(room, new Set([connection]));
  }

  private deindex(room: RoomName, connection: RealtimeConnection): void {
    const members = this.byRoom.get(room);
    if (!members) return;
    members.delete(connection);
    if (members.size === 0) this.byRoom.delete(room);
  }
}
