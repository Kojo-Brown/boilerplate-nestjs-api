import { RealtimeCloseCode } from "./close-codes";
import { laggedFrame, type RealtimeFrame } from "./realtime-frames";
import { SOCKET_OPEN, systemRealtimeClock, type RealtimeClock, type RealtimeSocket } from "./ports";

export interface BackpressureOptions {
  /**
   * Bytes of unflushed send buffer past which this connection stops being sent
   * events.
   */
  readonly highWaterMarkBytes: number;
  /**
   * How long a connection may stay over the mark before it is closed.
   *
   * Zero would make a single slow read fatal; unbounded would make a wedged
   * peer immortal. See {@link BackpressuredSocket} for why the answer is a
   * window rather than either.
   */
  readonly graceMs: number;
}

/** What one {@link BackpressuredSocket.send} did. */
export type SendOutcome =
  /** Handed to the socket. */
  | "sent"
  /** Deliberately not sent: the peer is behind. The client will be told. */
  | "dropped"
  /** The socket is not open, or was closed by this call. Nothing more will be sent. */
  | "closed";

/**
 * One connection's send side, with the policy that keeps a slow reader from
 * taking the process down with it.
 *
 * ### The failure this exists to prevent
 *
 * `socket.send()` on a peer that has stopped reading does not block and does
 * not fail. It appends to an in-process buffer, and `bufferedAmount` grows.
 * Nothing in `ws`, in Node, or in the kernel ever pushes back — so a broadcast
 * loop that writes to every connection writes just as eagerly to the one behind
 * a stalled mobile radio as to the ninety-nine that are keeping up. The
 * arithmetic is unforgiving: at a modest 200 events/second and a 2 KB payload,
 * a single peer that stops reading for a minute is 24 MB of heap that nothing
 * will reclaim until it disconnects. A handful of them is the process.
 *
 * ### The three candidate policies
 *
 * **Buffer anyway** is what the naive gateway does, and it is the failure
 * above: one client's network decides everyone's availability.
 *
 * **Close immediately** bounds memory but is far too eager. `bufferedAmount`
 * spikes over any high-water mark during an ordinary burst — a client that is
 * reading perfectly well is simply a round trip behind — so this disconnects
 * healthy clients under exactly the load where staying connected matters most.
 *
 * **Drop, then close if it persists** — this. Over the mark, events stop being
 * written and are counted. If the peer drains back under the low-water mark the
 * connection recovers, and is told what it missed with a
 * {@link import("./realtime-frames").laggedFrame} so it can refetch rather than
 * carry on with a hole in its state. If it is still over the mark when
 * `graceMs` has elapsed, it is closed with
 * {@link RealtimeCloseCode.SLOW_CONSUMER}: at that point it is not a burst, and
 * a connection that cannot be delivered to is not a connection.
 *
 * Recovery uses a low-water mark at half the high, rather than the same
 * threshold in both directions. With one threshold a connection hovering near
 * it alternates between lagging and recovered on consecutive sends, and emits a
 * `realtime.lagged` frame — which instructs the client to refetch — on every
 * other event. The hysteresis makes "recovered" mean the peer has actually
 * caught up.
 *
 * ### Why dropping is safe here
 *
 * Because the client is *told*, and told in the vocabulary the rest of this
 * codebase already uses for the same situation: `stream.open`'s `gap` field on
 * the SSE endpoint says "you may have missed events, refetch". Silent loss is
 * what makes dropping unacceptable, not loss itself. A stream that guarantees
 * delivery to a peer that will not read is a stream that has no bound on its
 * memory, and this application has a durable path — the outbox and the Kafka
 * topic — for anything that genuinely may not be lost.
 */
export class BackpressuredSocket {
  private readonly lowWaterMarkBytes: number;

  /** When this connection first went over the high-water mark, or `null`. */
  private laggingSince: number | null = null;
  private droppedWhileLagging = 0;

  /** Frames dropped over the life of the connection. Read for logging on disconnect. */
  private droppedTotal = 0;

  constructor(
    private readonly socket: RealtimeSocket,
    private readonly options: BackpressureOptions,
    private readonly clock: RealtimeClock = systemRealtimeClock,
  ) {
    this.lowWaterMarkBytes = Math.floor(options.highWaterMarkBytes / 2);
  }

  get isLagging(): boolean {
    return this.laggingSince !== null;
  }

  get dropped(): number {
    return this.droppedTotal;
  }

  get isOpen(): boolean {
    return this.socket.readyState === SOCKET_OPEN;
  }

  /**
   * Writes one frame, subject to the policy above.
   *
   * Control frames go through here too, and deliberately so: an ack written
   * past the high-water mark is another kilobyte on a buffer that is already
   * the problem, and there is nothing a client can do with a `realtime.subscribed`
   * it will not read for a minute. The one exception is the lagged frame
   * itself, which is written by {@link recover} at the moment the buffer is
   * known to be under the low-water mark.
   */
  send(frame: RealtimeFrame): SendOutcome {
    if (!this.isOpen) return "closed";

    if (this.laggingSince !== null) {
      if (this.socket.bufferedAmount > this.lowWaterMarkBytes) {
        return this.stayLagging();
      }
      this.recover();
    } else if (this.socket.bufferedAmount > this.options.highWaterMarkBytes) {
      this.laggingSince = this.clock.now();
      this.droppedWhileLagging = 0;
      return this.stayLagging();
    }

    this.write(frame);
    return "sent";
  }

  /**
   * Re-evaluates a lagging connection against the clock.
   *
   * Without this the grace window is only ever checked on the next send, so a
   * connection that goes quiet the instant after it falls behind — which is the
   * common case, because it fell behind during a burst that has now passed —
   * would hold its slot and its buffered megabytes indefinitely. The gateway's
   * heartbeat sweep calls this on every connection, which is also why the sweep
   * exists at a fixed interval rather than per socket.
   */
  review(): void {
    if (!this.isOpen || this.laggingSince === null) return;

    if (this.clock.now() - this.laggingSince >= this.options.graceMs) {
      this.closeSlow();
      return;
    }

    if (this.socket.bufferedAmount <= this.lowWaterMarkBytes) this.recover();
  }

  close(code: number, reason: string): void {
    if (this.isOpen) this.socket.close(code, reason);
  }

  /** Sends a protocol-level ping. Answered by a `pong` the gateway listens for. */
  ping(): void {
    if (this.isOpen) this.socket.ping();
  }

  /**
   * Drops the connection without a close handshake.
   *
   * For the peer that has stopped answering pings: a close frame asks for a
   * reply from the side that is already not replying, so `close()` there leaves
   * the socket in `CLOSING` until `ws`'s own timeout, still holding its slot.
   */
  terminate(): void {
    this.socket.terminate();
  }

  /** Sends a frame regardless of buffer state. Only for the farewell on shutdown. */
  sendUnconditionally(frame: RealtimeFrame): void {
    if (this.isOpen) this.write(frame);
  }

  private stayLagging(): SendOutcome {
    this.droppedWhileLagging += 1;
    this.droppedTotal += 1;

    if (
      this.laggingSince !== null &&
      this.clock.now() - this.laggingSince >= this.options.graceMs
    ) {
      this.closeSlow();
      return "closed";
    }

    return "dropped";
  }

  private recover(): void {
    const since = this.laggingSince;
    const dropped = this.droppedWhileLagging;
    this.laggingSince = null;
    this.droppedWhileLagging = 0;
    if (since !== null) this.write(laggedFrame(dropped, new Date(since)));
  }

  private closeSlow(): void {
    this.socket.close(
      RealtimeCloseCode.SLOW_CONSUMER,
      // Close reasons are capped at 123 bytes by RFC 6455 §5.5; this is well
      // inside it for any plausible count, and `ws` would throw rather than
      // truncate if it were not.
      `slow consumer: ${this.droppedWhileLagging} frames dropped`,
    );
    this.laggingSince = null;
  }

  private write(frame: RealtimeFrame): void {
    // No send callback: `ws` emits `error` on the socket when a write fails and
    // no callback was given, and `WsAdapter` already binds a handler that logs
    // it. A callback here would be a second, quieter place for the same error
    // to be reported from.
    this.socket.send(JSON.stringify(frame));
  }
}
