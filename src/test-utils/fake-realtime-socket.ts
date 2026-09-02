import { SOCKET_OPEN, type RealtimeClock, type RealtimeSocket } from "@/realtime";

/**
 * A socket whose send buffer the test moves by hand.
 *
 * The behaviour under test is a policy over `bufferedAmount`, and the honest
 * alternative — a real peer that reads slowly — is a race with a threshold in
 * it. Setting the number directly is the only way to assert "one byte under the
 * low-water mark recovers, one byte over does not" and have it mean the same
 * thing on every machine.
 *
 * Sent frames are kept parsed rather than as JSON strings, because every
 * assertion in the suite is about a frame's `event` and `data` and none is
 * about its serialisation.
 */
export class FakeRealtimeSocket implements RealtimeSocket {
  readyState = SOCKET_OPEN;
  bufferedAmount = 0;

  readonly sent: { event: string; data: unknown }[] = [];
  readonly pings: number[] = [];
  closed: { code?: number; reason?: string } | null = null;
  terminated = false;

  private readonly listeners = new Map<string, (() => void)[]>();

  constructor(private readonly clock?: RealtimeClock) {}

  /**
   * The one `ws` event the gateway subscribes to directly.
   *
   * Not part of {@link RealtimeSocket} — the gateway binds it on the real
   * socket it is handed, which is why the double has to answer to it even
   * though nothing else in the module does.
   */
  on(event: string, listener: () => void): this {
    const bound = this.listeners.get(event);
    if (bound) bound.push(listener);
    else this.listeners.set(event, [listener]);
    return this;
  }

  /** Delivers the peer's answer to a ping. */
  pong(): void {
    for (const listener of this.listeners.get("pong") ?? []) listener();
  }

  send(data: string): void {
    this.sent.push(JSON.parse(data) as { event: string; data: unknown });
  }

  close(code?: number, reason?: string): void {
    // A real `close()` starts a handshake and leaves `readyState` at CLOSING
    // until the peer answers. Going straight to CLOSED here would hide a bug
    // where the gateway keeps writing to a socket it has closed, so the state
    // is moved to CLOSING (2) — still not OPEN, which is all `isOpen` reads.
    this.readyState = 2;
    this.closed = { code, reason };
  }

  terminate(): void {
    this.readyState = 3;
    this.terminated = true;
  }

  ping(): void {
    this.pings.push(this.clock?.now() ?? 0);
  }

  /** The frames sent so far, as event names. The usual shape of an assertion. */
  eventNames(): string[] {
    return this.sent.map((frame) => frame.event);
  }

  lastFrame(): { event: string; data: unknown } | undefined {
    return this.sent.at(-1);
  }
}

/** A clock the test advances explicitly, for the slow-consumer grace window. */
export class FakeRealtimeClock implements RealtimeClock {
  constructor(private current = 1_000) {}

  now(): number {
    return this.current;
  }

  advance(ms: number): void {
    this.current += ms;
  }
}
