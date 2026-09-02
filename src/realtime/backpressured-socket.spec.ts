import { FakeRealtimeClock, FakeRealtimeSocket } from "@/test-utils/fake-realtime-socket";
import { BackpressuredSocket } from "./backpressured-socket";
import { RealtimeCloseCode } from "./close-codes";
import type { RealtimeFrame } from "./realtime-frames";

const HIGH_WATER = 1_000;
const LOW_WATER = HIGH_WATER / 2;
const GRACE_MS = 10_000;

function frame(n: number): RealtimeFrame {
  return { event: "user.registered", data: { n } };
}

function build() {
  const clock = new FakeRealtimeClock();
  const socket = new FakeRealtimeSocket(clock);
  const writer = new BackpressuredSocket(
    socket,
    { highWaterMarkBytes: HIGH_WATER, graceMs: GRACE_MS },
    clock,
  );
  return { clock, socket, writer };
}

describe("BackpressuredSocket", () => {
  it("writes through while the peer is keeping up", () => {
    const { socket, writer } = build();

    socket.bufferedAmount = HIGH_WATER;

    expect(writer.send(frame(1))).toBe("sent");
    expect(writer.isLagging).toBe(false);
    expect(socket.sent).toEqual([{ event: "user.registered", data: { n: 1 } }]);
  });

  it("stops writing once the send buffer passes the high-water mark", () => {
    const { socket, writer } = build();

    socket.bufferedAmount = HIGH_WATER + 1;

    expect(writer.send(frame(1))).toBe("dropped");
    expect(writer.isLagging).toBe(true);
    expect(socket.sent).toEqual([]);
    expect(writer.dropped).toBe(1);
  });

  it("does not recover at the high-water mark, only at the low one", () => {
    // Without the hysteresis, a connection hovering at the threshold alternates
    // between lagging and recovered and emits a `realtime.lagged` — which tells
    // the client to refetch — on every other event.
    const { socket, writer } = build();

    socket.bufferedAmount = HIGH_WATER + 1;
    writer.send(frame(1));

    socket.bufferedAmount = LOW_WATER + 1;
    expect(writer.send(frame(2))).toBe("dropped");
    expect(writer.isLagging).toBe(true);

    socket.bufferedAmount = LOW_WATER;
    expect(writer.send(frame(3))).toBe("sent");
    expect(writer.isLagging).toBe(false);
  });

  it("tells a recovered client what it missed, before the event that recovered it", () => {
    const { socket, writer } = build();

    socket.bufferedAmount = HIGH_WATER + 1;
    writer.send(frame(1));
    writer.send(frame(2));

    socket.bufferedAmount = 0;
    expect(writer.send(frame(3))).toBe("sent");

    expect(socket.eventNames()).toEqual(["realtime.lagged", "user.registered"]);
    expect(socket.sent[0]?.data).toMatchObject({ dropped: 2, refetchRequired: true });
  });

  it("dates the lagged frame from when the connection first fell behind", () => {
    const { clock, socket, writer } = build();
    const fellBehindAt = clock.now();

    socket.bufferedAmount = HIGH_WATER + 1;
    writer.send(frame(1));
    clock.advance(3_000);

    socket.bufferedAmount = 0;
    writer.send(frame(2));

    expect(socket.sent[0]?.data).toMatchObject({ since: new Date(fellBehindAt).toISOString() });
  });

  it("closes a connection that is still behind when the grace window expires", () => {
    const { clock, socket, writer } = build();

    socket.bufferedAmount = HIGH_WATER + 1;
    writer.send(frame(1));

    clock.advance(GRACE_MS - 1);
    expect(writer.send(frame(2))).toBe("dropped");
    expect(socket.closed).toBeNull();

    clock.advance(1);
    expect(writer.send(frame(3))).toBe("closed");
    expect(socket.closed).toEqual({
      code: RealtimeCloseCode.SLOW_CONSUMER,
      reason: "slow consumer: 3 frames dropped",
    });
  });

  it("keeps the close reason inside the 123 bytes RFC 6455 allows", () => {
    const { clock, socket, writer } = build();

    socket.bufferedAmount = HIGH_WATER + 1;
    for (let i = 0; i < 5_000; i += 1) writer.send(frame(i));
    clock.advance(GRACE_MS);
    writer.send(frame(-1));

    expect(Buffer.byteLength(socket.closed?.reason ?? "", "utf8")).toBeLessThanOrEqual(123);
  });

  it("expires a connection that fell behind and then went quiet", () => {
    // The hole `review` exists to close: the grace window is otherwise only ever
    // checked on the next send, and a connection that falls behind during a
    // burst usually goes quiet the moment the burst passes.
    const { clock, socket, writer } = build();

    socket.bufferedAmount = HIGH_WATER + 1;
    writer.send(frame(1));

    clock.advance(GRACE_MS);
    writer.review();

    expect(socket.closed).toMatchObject({ code: RealtimeCloseCode.SLOW_CONSUMER });
  });

  it("recovers a quiet connection from review, without waiting for an event", () => {
    const { socket, writer } = build();

    socket.bufferedAmount = HIGH_WATER + 1;
    writer.send(frame(1));

    socket.bufferedAmount = 0;
    writer.review();

    expect(writer.isLagging).toBe(false);
    expect(socket.eventNames()).toEqual(["realtime.lagged"]);
  });

  it("does nothing on review while the connection is healthy", () => {
    const { socket, writer } = build();

    writer.review();

    expect(socket.sent).toEqual([]);
    expect(socket.closed).toBeNull();
  });

  it("reports every write to a socket that is not open as closed", () => {
    const { socket, writer } = build();

    socket.readyState = 3;

    expect(writer.isOpen).toBe(false);
    expect(writer.send(frame(1))).toBe("closed");
    expect(socket.sent).toEqual([]);
  });

  it("does not write, ping or close a socket it has already closed", () => {
    const { socket, writer } = build();

    writer.close(RealtimeCloseCode.GOING_AWAY, "bye");
    socket.closed = null;

    writer.close(RealtimeCloseCode.GOING_AWAY, "bye again");
    writer.ping();
    writer.sendUnconditionally(frame(1));

    expect(socket.closed).toBeNull();
    expect(socket.pings).toEqual([]);
    expect(socket.sent).toEqual([]);
  });

  it("writes the farewell even to a connection that is over the mark", () => {
    // The process is going away in milliseconds; the buffer this adds to will
    // not outlive it, and a client that is behind still needs to know this was
    // a deploy rather than its network.
    const { socket, writer } = build();

    socket.bufferedAmount = HIGH_WATER * 100;
    writer.sendUnconditionally({ event: "realtime.closing", data: { reason: "shutdown" } });

    expect(socket.eventNames()).toEqual(["realtime.closing"]);
  });

  it("terminates rather than closing, for a peer that has stopped answering", () => {
    const { socket, writer } = build();

    writer.terminate();

    expect(socket.terminated).toBe(true);
    expect(socket.closed).toBeNull();
  });

  it("counts drops across recoveries for the disconnect log line", () => {
    const { socket, writer } = build();

    socket.bufferedAmount = HIGH_WATER + 1;
    writer.send(frame(1));
    socket.bufferedAmount = 0;
    writer.send(frame(2));

    socket.bufferedAmount = HIGH_WATER + 1;
    writer.send(frame(3));
    writer.send(frame(4));

    expect(writer.dropped).toBe(3);
  });
});
