import type { IncomingHttpHeaders } from "http";

/**
 * `WebSocket.OPEN`, as a number this module can compare against without
 * importing `ws` into files that have no other reason to know the transport.
 *
 * The constant lives here rather than being read off the `ws` package because
 * {@link RealtimeSocket} exists precisely so that a unit spec can drive the
 * backpressure policy with a hand-written double; a double that had to import
 * `ws` to name its own ready state would defeat that.
 */
export const SOCKET_OPEN = 1;

/**
 * The subset of `ws.WebSocket` this module writes through.
 *
 * `bufferedAmount` is the reason this interface is narrow rather than absent.
 * It is the only honest measure of a slow consumer available to a Node
 * WebSocket server — bytes handed to `send()` that the kernel has not yet
 * accepted — and it is what {@link import("./backpressured-socket").BackpressuredSocket}
 * makes its decisions from. Naming it in an interface lets those decisions be
 * tested by moving a number, instead of by building a real peer that reads
 * slowly, which is a race dressed up as a test.
 */
export interface RealtimeSocket {
  readonly readyState: number;
  /** Bytes queued by `send()` and not yet flushed to the socket. */
  readonly bufferedAmount: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  terminate(): void;
  ping(): void;
}

/** The HTTP upgrade request, as {@link import("./handshake").readHandshakeCredentials} reads it. */
export interface HandshakeRequest {
  readonly url?: string | undefined;
  readonly headers: IncomingHttpHeaders;
}

/**
 * The clock the slow-consumer grace window is measured against.
 *
 * A local port rather than a shared one, matching `AspectClock` and
 * `LockClock`: each is a single method, and a module that named a common clock
 * would couple three unrelated features together to save one interface.
 */
export interface RealtimeClock {
  now(): number;
}

export const systemRealtimeClock: RealtimeClock = { now: () => Date.now() };

/**
 * What {@link import("./handshake").authenticateHandshake} needs from
 * `JwtService`.
 *
 * Declared structurally so the handshake spec can verify tokens with a
 * three-line double instead of standing up `JwtModule` — and so this file names
 * the one method the gateway actually calls, which is the whole of the
 * dependency.
 */
export interface HandshakeTokenVerifier {
  verify(token: string): unknown;
}
