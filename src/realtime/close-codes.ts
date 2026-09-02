/**
 * The close codes this gateway sends, and the only channel it has for saying
 * *why* a connection ended.
 *
 * This matters more for a WebSocket than the equivalent does for an HTTP
 * endpoint. Authentication happens after the upgrade (see
 * {@link import("./realtime.gateway").RealtimeGateway.handleConnection} for why
 * it has to), so a browser never sees a status line: `WebSocket` reports a
 * failed handshake as an opaque error with no code at all. A close code, by
 * contrast, arrives on `CloseEvent.code` and is the one piece of machine-readable
 * diagnosis the client gets. The difference between "get a new token" and "back
 * off and retry" lives entirely in these numbers.
 *
 * 4000–4999 is the range RFC 6455 §7.4.2 reserves for private use, so the codes
 * below mirror the HTTP status they correspond to — 4401 for 401, 4429 for 429
 * — which makes them readable without a table. `GOING_AWAY` is 1001 from the
 * registered range because it means exactly what the registry says it means.
 */
export const RealtimeCloseCode = {
  /** The process is shutting down. Reconnect through the load balancer. */
  GOING_AWAY: 1001,
  /** No usable credentials in the handshake, or the token did not verify. */
  UNAUTHENTICATED: 4401,
  /** The token verified but carried claims this build cannot make a principal from. */
  FORBIDDEN: 4403,
  /**
   * The peer stopped draining its socket for longer than the grace window.
   *
   * Distinct from `UNAUTHENTICATED` in the one way that matters to a client:
   * reconnecting immediately with the same token is the correct response, but
   * only if it also fixes whatever kept it from reading — otherwise it will be
   * closed again, and the `realtime.lagged` frames it received first say so.
   */
  SLOW_CONSUMER: 4408,
  /** This process is already holding `WS_MAX_CONNECTIONS` sockets. */
  AT_CAPACITY: 4429,
} as const;

export type RealtimeCloseCodeValue = (typeof RealtimeCloseCode)[keyof typeof RealtimeCloseCode];
