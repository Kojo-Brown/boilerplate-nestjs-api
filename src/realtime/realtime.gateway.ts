import {
  Logger,
  type BeforeApplicationShutdown,
  type OnApplicationBootstrap,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { JwtService } from "@nestjs/jwt";
import {
  ConnectedSocket,
  MessageBody,
  SubscribeMessage,
  WebSocketGateway,
  type OnGatewayConnection,
  type OnGatewayDisconnect,
} from "@nestjs/websockets";
import { randomUUID } from "crypto";
import type { IncomingMessage } from "http";
import type { WebSocket } from "ws";
import { OnDomainEvent, type AnyDomainEvent, type DomainEvent } from "@/events";
import { isVisibleTo, type StreamAudience } from "@/streaming";
import { BackpressuredSocket } from "./backpressured-socket";
import { RealtimeCloseCode } from "./close-codes";
import { ConnectionRegistry, type RealtimeConnection } from "./connection-registry";
import { authenticateHandshake, type HandshakeRejection } from "./handshake";
import {
  closingFrame,
  domainEventFrame,
  errorFrame,
  subscribedFrame,
  unsubscribedFrame,
  welcomeFrame,
  type RealtimeErrorCode,
} from "./realtime-frames";
import { canJoin, defaultRoomsFor, parseRoom, roomsFor, type RoomName } from "./rooms";

/**
 * The upgrade path. Under `/v1/` like every other route, so a load balancer
 * that routes this API by prefix needs no rule of its own for it.
 */
export const REALTIME_PATH = "/v1/realtime";

/**
 * The largest frame a client may send, in bytes.
 *
 * A constant rather than a setting, because it is a property of the protocol
 * rather than of a deployment: the only messages this gateway accepts are
 * `subscribe` and `unsubscribe`, and the largest legitimate one is
 * `WS_MAX_ROOMS_PER_CONNECTION` room names — a few kilobytes at the default.
 * `ws` enforces it before the frame is buffered or parsed, closing with 1009,
 * which is the only place it *can* be enforced: by the time a handler sees a
 * message, the memory has already been allocated.
 */
export const MAX_INBOUND_FRAME_BYTES = 16 * 1024;

export interface RealtimeOptions {
  readonly maxConnections: number;
  readonly maxRoomsPerConnection: number;
  readonly sendHighWaterMarkBytes: number;
  readonly slowConsumerGraceMs: number;
  readonly heartbeatIntervalMs: number;
}

export function realtimeOptionsFrom(config: ConfigService): RealtimeOptions {
  return {
    maxConnections: config.get<number>("WS_MAX_CONNECTIONS", 1_000),
    maxRoomsPerConnection: config.get<number>("WS_MAX_ROOMS_PER_CONNECTION", 64),
    sendHighWaterMarkBytes: config.get<number>("WS_SEND_HIGH_WATER_MARK_BYTES", 1_048_576),
    slowConsumerGraceMs: config.get<number>("WS_SLOW_CONSUMER_GRACE_MS", 10_000),
    heartbeatIntervalMs: config.get<number>("WS_HEARTBEAT_INTERVAL_MS", 30_000),
  };
}

/** The one shape `subscribe` and `unsubscribe` accept. */
interface RoomRequest {
  readonly rooms: readonly string[];
}

/**
 * The WebSocket gateway: `wss://…/v1/realtime`.
 *
 * It is a `@OnDomainEvent` subscriber like `EventStreamHub`, and for the same
 * reason — `DomainEventConsumer` puts what it reads off the Kafka topic onto
 * `DomainEventBus`, so an event produced by another replica arrives here
 * indistinguishably from a local one and fans out to this process's sockets
 * without anything in this file mentioning a broker.
 *
 * `docs/streaming.md` argues that SSE is the right default for one-directional
 * delivery, and it still is. This exists for the case that one is not: a client
 * that must *send* as well as receive — changing its subscription while
 * connected, which over SSE means tearing the connection down and reopening it
 * with different query parameters. What that duplex channel costs is written
 * out in `docs/realtime.md`; the three parts of the bill are settled here.
 *
 * **Authentication happens after the upgrade, in {@link handleConnection}.**
 * Not by preference. A Nest guard runs on `@SubscribeMessage` handlers, never
 * on the handshake, so a gateway that relies on guards accepts every socket
 * that reaches it and only asks who it belongs to once it sends a message —
 * which a socket that never sends one never does. Rejecting before the upgrade
 * is not available either: `WsAdapter` calls `handleUpgrade` itself, so `ws`'s
 * `verifyClient` hook is never consulted. What is left is to verify
 * synchronously in the connection handler, before the socket is registered or
 * placed in any room, and close it if it fails. Synchronously matters: an
 * `await` between the upgrade and the close is a window in which an
 * unauthenticated socket exists and can send frames, so
 * {@link authenticateHandshake} uses `JwtService.verify` rather than
 * `verifyAsync`.
 *
 * The consolation is that the client is told more than an HTTP 401 could tell
 * it. A browser cannot read the status of a failed WebSocket handshake, but it
 * can read `CloseEvent.code` — so the reason arrives as one of the
 * {@link RealtimeCloseCode} values and a client can tell "get a new token"
 * from "back off".
 *
 * **Rooms** are in `rooms.ts`, and they are an interest filter rather than a
 * permission: every emit is still checked against `isVisibleTo`, the same
 * exhaustive rule the SSE endpoint uses.
 *
 * **Backpressure** is in `backpressured-socket.ts`, which is where a slow peer
 * stops being everyone else's problem.
 */
@WebSocketGateway({ path: REALTIME_PATH, maxPayload: MAX_INBOUND_FRAME_BYTES })
export class RealtimeGateway
  implements
    OnGatewayConnection<WebSocket>,
    OnGatewayDisconnect<WebSocket>,
    OnApplicationBootstrap,
    BeforeApplicationShutdown
{
  private readonly logger = new Logger(RealtimeGateway.name);
  private readonly registry = new ConnectionRegistry();
  private readonly options: RealtimeOptions;

  private sweep?: NodeJS.Timeout;

  /**
   * An ordinary class provider with injected dependencies, where
   * `StreamingModule` binds its hub through a `useFactory`.
   *
   * Not a style choice: `SocketModule` finds gateways by reading
   * `Reflect.getMetadataKeys` off each provider's `metatype`, and a
   * `useFactory` provider's metatype is the factory function. A gateway
   * constructed that way is silently never connected to a server — no error, no
   * log line, just an endpoint that answers nothing.
   */
  constructor(
    config: ConfigService,
    private readonly jwt: JwtService,
  ) {
    this.options = realtimeOptionsFrom(config);
  }

  /** How many authenticated sockets this process is holding. For tests and logs. */
  get openConnections(): number {
    return this.registry.size;
  }

  /**
   * Authenticates the handshake, then admits the socket.
   *
   * The order of the two refusals below is load-bearing. Verifying first means
   * an unauthenticated flood is measured against nothing — those sockets are
   * closed without ever being counted — where checking capacity first would let
   * anyone who can reach the port exhaust the budget of a paying client. The
   * cost is one HMAC verification per rejected handshake, which is orders of
   * magnitude cheaper than the connection it refuses.
   */
  handleConnection(socket: WebSocket, request: IncomingMessage): void {
    const handshake = authenticateHandshake(request, this.jwt);
    if (!handshake.ok) {
      this.logger.warn(`Refusing WebSocket handshake: ${handshake.rejection}`);
      socket.close(closeCodeFor(handshake.rejection), handshake.rejection);
      return;
    }

    if (this.registry.size >= this.options.maxConnections) {
      this.logger.warn(
        `Refusing WebSocket handshake for user ${handshake.user.id}: at capacity (${this.options.maxConnections})`,
      );
      socket.close(RealtimeCloseCode.AT_CAPACITY, "at capacity");
      return;
    }

    const audience: StreamAudience = { id: handshake.user.id, role: handshake.user.role };
    const rooms = defaultRoomsFor(audience);
    const connection: RealtimeConnection = {
      id: randomUUID(),
      audience,
      writer: new BackpressuredSocket(socket, {
        highWaterMarkBytes: this.options.sendHighWaterMarkBytes,
        graceMs: this.options.slowConsumerGraceMs,
      }),
      rooms: new Set(rooms),
      awaitingPong: false,
    };

    this.registry.add(socket, connection);
    // Bound here rather than in the sweep: `ws` emits `pong` on the socket, and
    // the registry deliberately knows nothing about the transport's events.
    socket.on("pong", () => {
      connection.awaitingPong = false;
    });

    connection.writer.send(
      welcomeFrame({
        connectionId: connection.id,
        userId: audience.id,
        role: audience.role,
        rooms,
        heartbeatIntervalMs: this.options.heartbeatIntervalMs,
        limits: {
          maxRooms: this.options.maxRoomsPerConnection,
          sendHighWaterMarkBytes: this.options.sendHighWaterMarkBytes,
        },
      }),
    );
  }

  handleDisconnect(socket: WebSocket): void {
    const connection = this.registry.remove(socket);
    if (connection && connection.writer.dropped > 0) {
      // The only place a drop is visible to an operator. A connection that fell
      // behind and recovered told its client and nobody else.
      this.logger.warn(
        `Connection ${connection.id} (user ${connection.audience.id}) closed after dropping ${connection.writer.dropped} frame(s)`,
      );
    }
  }

  /**
   * `{ "event": "subscribe", "data": { "rooms": ["events:user.registered"] } }`
   *
   * All-or-nothing: one bad room refuses the whole frame. Applying the valid
   * half and reporting the rest would leave the client's idea of its own
   * subscription and the server's disagreeing, which is the bug this protocol
   * is least able to help anyone debug — the `allRooms` field on the reply
   * exists so a client never has to reconstruct that state from deltas.
   */
  @SubscribeMessage("subscribe")
  handleSubscribe(@ConnectedSocket() socket: WebSocket, @MessageBody() body: unknown): void {
    const connection = this.registry.get(socket);
    if (!connection) return;

    const parsed = this.parseRooms(connection, body, "join");
    if (!parsed.ok) {
      connection.writer.send(errorFrame(parsed.code, parsed.message, parsed.room));
      return;
    }

    const joined = parsed.rooms.filter((room) => this.registry.join(connection, room));
    connection.writer.send(subscribedFrame(joined, [...connection.rooms]));
  }

  /** `{ "event": "unsubscribe", "data": { "rooms": ["events:user.registered"] } }` */
  @SubscribeMessage("unsubscribe")
  handleUnsubscribe(@ConnectedSocket() socket: WebSocket, @MessageBody() body: unknown): void {
    const connection = this.registry.get(socket);
    if (!connection) return;

    const parsed = this.parseRooms(connection, body, "leave");
    if (!parsed.ok) {
      connection.writer.send(errorFrame(parsed.code, parsed.message, parsed.room));
      return;
    }

    const left = parsed.rooms.filter((room) => this.registry.leave(connection, room));
    connection.writer.send(unsubscribedFrame(left, [...connection.rooms]));
  }

  @OnDomainEvent("user.registered")
  onUserRegistered(event: DomainEvent<"user.registered">): void {
    this.broadcast(event);
  }

  @OnDomainEvent("user.deleted")
  onUserDeleted(event: DomainEvent<"user.deleted">): void {
    this.broadcast(event);
  }

  @OnDomainEvent("order.placed")
  onOrderPlaced(event: DomainEvent<"order.placed">): void {
    this.broadcast(event);
  }

  @OnDomainEvent("order.confirmed")
  onOrderConfirmed(event: DomainEvent<"order.confirmed">): void {
    this.broadcast(event);
  }

  @OnDomainEvent("order.cancelled")
  onOrderCancelled(event: DomainEvent<"order.cancelled">): void {
    this.broadcast(event);
  }

  onApplicationBootstrap(): void {
    this.sweep = setInterval(() => this.runSweep(), this.options.heartbeatIntervalMs);
    // The timer must not be what keeps the process alive. `EventStreamHub` has
    // the same note for the same reason: a heartbeat that holds the event loop
    // open turns every graceful shutdown into the force-exit in `main.ts`.
    this.sweep.unref();
  }

  /**
   * `beforeApplicationShutdown`, not `onApplicationShutdown` — and the
   * difference is the whole hook.
   *
   * `NestApplicationContext.close()` runs destroy hooks, then
   * `beforeApplicationShutdown`, then `dispose()`, then
   * `onApplicationShutdown`. `dispose()` is where `SocketModule.close()`
   * calls `terminate()` on every client: no close frame, no code, nothing the
   * client can distinguish from the network failing. By the time
   * `onApplicationShutdown` runs — which is where the SSE hub does its
   * equivalent work, correctly, because an SSE response is not a socket the
   * socket module owns — every WebSocket is already gone.
   */
  beforeApplicationShutdown(): void {
    clearInterval(this.sweep);

    const connections = [...this.registry.connections()];
    if (connections.length > 0) {
      this.logger.log(`Closing ${connections.length} open WebSocket connection(s)`);
    }

    for (const connection of connections) {
      // Unconditionally: a client that is behind still needs to be told this
      // was a deploy rather than its network, and the process is going away in
      // milliseconds so the buffer this adds to will not outlive it.
      connection.writer.sendUnconditionally(closingFrame());
      connection.writer.close(RealtimeCloseCode.GOING_AWAY, "server shutting down");
    }
  }

  /**
   * Delivers one event to every connection that is both interested and allowed.
   *
   * `considered` is not an optimisation. A connection can be in more than one
   * of the rooms an event routes to — an administrator subscribed to
   * `events:user.registered` who is also in their own `user:<id>` room receives
   * their own registration through both — and without the set it would be sent
   * the same frame twice.
   *
   * The visibility check is applied here rather than at subscription time
   * because it is the guarantee: `canJoin` decides what is worth indexing,
   * `isVisibleTo` decides what may be written. Everything a socket receives
   * passes through this line.
   */
  private broadcast(event: AnyDomainEvent): void {
    const frame = domainEventFrame(event);
    const considered = new Set<RealtimeConnection>();

    for (const room of roomsFor(event)) {
      // Snapshotted: `send` may close a socket, and a closed socket is removed
      // from these very sets by `handleDisconnect`. `ws` fires `close`
      // asynchronously today, so this is insurance rather than a fix — but it
      // is insurance against a crash whose trigger would be a slow client.
      for (const connection of [...this.registry.membersOf(room)]) {
        if (considered.has(connection)) continue;
        considered.add(connection);
        if (!isVisibleTo(event, connection.audience)) continue;
        connection.writer.send(frame);
      }
    }
  }

  /**
   * One pass over every connection: expire the lagging, ping the quiet.
   *
   * A single interval for the whole process rather than a timer per socket.
   * With a thousand connections that is one timer instead of a thousand, and
   * the sweep is also the only thing that re-examines a connection that fell
   * behind and then went silent — see {@link BackpressuredSocket.review}.
   */
  private runSweep(): void {
    for (const connection of [...this.registry.connections()]) {
      connection.writer.review();
      if (!connection.writer.isOpen) continue;

      if (connection.awaitingPong) {
        // `terminate`, not `close`: the peer has already failed to answer for a
        // full interval, and a close handshake waits for a reply from exactly
        // the peer that is not replying.
        this.logger.warn(
          `Connection ${connection.id} (user ${connection.audience.id}) missed a heartbeat — terminating`,
        );
        connection.writer.terminate();
        continue;
      }

      connection.awaitingPong = true;
      connection.writer.ping();
    }
  }

  /**
   * Validates a room frame in full before any of it is applied.
   *
   * Hand-written rather than a `ValidationPipe` over a class-validator DTO, and
   * the reason is what happens on failure. A pipe throws; Nest's `WsProxy`
   * routes the exception to `BaseWsExceptionFilter`, which writes a frame in a
   * vocabulary this protocol does not otherwise use and which bypasses
   * {@link BackpressuredSocket} — so a client already over its high-water mark
   * would be sent more. Refusing here keeps every byte this gateway writes
   * going through one place and one shape.
   */
  private parseRooms(
    connection: RealtimeConnection,
    body: unknown,
    intent: "join" | "leave",
  ):
    | { ok: true; rooms: readonly RoomName[] }
    | { ok: false; code: RealtimeErrorCode; message: string; room?: string } {
    if (!isRoomRequest(body)) {
      return {
        ok: false,
        code: "malformed-payload",
        message:
          'Expected { "rooms": ["<room>", …] } with between 1 and ' +
          `${this.options.maxRoomsPerConnection} room names.`,
      };
    }

    if (body.rooms.length === 0 || body.rooms.length > this.options.maxRoomsPerConnection) {
      return {
        ok: false,
        code: body.rooms.length === 0 ? "malformed-payload" : "room-limit-exceeded",
        message: `A room frame carries between 1 and ${this.options.maxRoomsPerConnection} names.`,
      };
    }

    const rooms: RoomName[] = [];
    for (const raw of body.rooms) {
      const room = parseRoom(raw);
      if (!room) {
        return {
          ok: false,
          code: "unknown-room",
          message: "Not a room this build issues. Rooms are `user:<id>` or `events:<event name>`.",
          room: typeof raw === "string" ? raw : undefined,
        };
      }
      // Leaving a room is always allowed: a client that was admitted to a room
      // and later had its role changed must still be able to get out of it, and
      // refusing that would strand the membership until it reconnected.
      if (intent === "join" && !canJoin(connection.audience, room)) {
        return {
          ok: false,
          code: "forbidden-room",
          message: "This account may not subscribe to that room.",
          room,
        };
      }
      rooms.push(room);
    }

    if (intent === "join") {
      const after = new Set([...connection.rooms, ...rooms]);
      if (after.size > this.options.maxRoomsPerConnection) {
        return {
          ok: false,
          code: "room-limit-exceeded",
          message: `A connection may hold at most ${this.options.maxRoomsPerConnection} rooms.`,
        };
      }
    }

    return { ok: true, rooms };
  }
}

function isRoomRequest(body: unknown): body is RoomRequest {
  return (
    typeof body === "object" && body !== null && Array.isArray((body as { rooms?: unknown }).rooms)
  );
}

function closeCodeFor(rejection: HandshakeRejection): number {
  // `unexpected-claims` is a token this service signed that is not an access
  // token — a refresh flow gone wrong, or a client sending the wrong artefact.
  // Retrying with the same credential will not help, which is what separates it
  // from every other rejection here.
  return rejection === "unexpected-claims"
    ? RealtimeCloseCode.FORBIDDEN
    : RealtimeCloseCode.UNAUTHENTICATED;
}
