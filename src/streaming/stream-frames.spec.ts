import type { MessageEvent } from "@nestjs/common";
import { SseStream } from "@nestjs/core/router/sse-stream";
import { DOMAIN_EVENT_NAMES, type DomainEvent } from "@/events";
import {
  STREAM_CONTROL_EVENTS,
  closingFrame,
  eventFrame,
  heartbeatFrame,
  openFrame,
} from "./stream-frames";

const EPOCH = "0f8c1a2b3d4e5f60718293a4b5c6d7e8";

const registered: DomainEvent<"user.registered"> = {
  id: "evt-1",
  name: "user.registered",
  occurredAt: "2026-01-01T00:00:00.000Z",
  correlationId: "corr-1",
  payload: {
    userId: "user-1",
    email: "erin@example.com",
    name: "Erin Example",
    provider: null,
  },
};

/**
 * Renders a frame exactly as the running server would.
 *
 * A deliberate reach into `@nestjs/core`'s internals, because the property under
 * test is a property of that renderer rather than of the object handed to it:
 * `heartbeatFrame` is invisible to clients only if `SseStream` omits the `data:`
 * line for an empty `data`, and asserting on the object would leave that
 * dependency unstated and free to change under an upgrade.
 */
function render(frame: MessageEvent): string {
  const stream = new SseStream();
  let out = "";
  stream.on("data", (chunk: Buffer | string) => {
    out += chunk.toString();
  });
  stream.write(frame);
  return out;
}

describe("stream frames", () => {
  it("keeps every control name out of the domain event catalogue", () => {
    // The type-level check in `stream-frames.ts` covers the same ground at
    // compile time; this one survives a future where either list is built
    // rather than written literally.
    for (const control of STREAM_CONTROL_EVENTS) {
      expect(DOMAIN_EVENT_NAMES as readonly string[]).not.toContain(control);
    }
  });

  describe("eventFrame", () => {
    it("names the SSE event after the domain event, so clients can addEventListener", () => {
      expect(render(eventFrame(EPOCH, 7, registered))).toContain("event: user.registered\n");
    });

    it("carries the cursor as the frame id", () => {
      expect(render(eventFrame(EPOCH, 7, registered))).toContain(`id: ${EPOCH}.7\n`);
    });

    it("sends the envelope's identifiers alongside the payload", () => {
      const frame = eventFrame(EPOCH, 7, registered);

      expect(frame.data).toEqual({
        id: "evt-1",
        name: "user.registered",
        occurredAt: "2026-01-01T00:00:00.000Z",
        correlationId: "corr-1",
        payload: registered.payload,
      });
    });
  });

  describe("heartbeatFrame", () => {
    /**
     * The property the whole keep-alive design rests on. The SSE specification's
     * "dispatch the event" algorithm sets the client's last event ID from the
     * `id` buffer in step 1 and then returns *without dispatching* when the data
     * buffer is empty in step 2 — so a frame with an `id` and no `data:` line
     * refreshes the resume cursor and fires no handler. If `SseStream` ever
     * starts writing `data:` for an empty string, every connected client begins
     * receiving a keep-alive event it was never told about, and this fails.
     */
    it("renders with an id and no data line, so no client event is dispatched", () => {
      const rendered = render(heartbeatFrame(EPOCH, 12));

      expect(rendered).toBe(`event: stream.heartbeat\nid: ${EPOCH}.12\n\n`);
      expect(rendered).not.toContain("data:");
    });
  });

  describe("openFrame", () => {
    it("carries the reconnection hint, which EventSource does not back off on its own", () => {
      expect(
        render(openFrame(EPOCH, 3, 2_500, { resumed: false, replayed: 0, gap: null })),
      ).toContain("retry: 2500\n");
    });

    it("reports a clean resume", () => {
      const frame = openFrame(EPOCH, 3, 3_000, { resumed: true, replayed: 2, gap: null });

      expect(frame.data).toEqual({
        epoch: EPOCH,
        cursor: `${EPOCH}.3`,
        resumed: true,
        replayed: 2,
        gap: null,
      });
    });

    it("names the gap when events may have been missed", () => {
      const frame = openFrame(EPOCH, 9, 3_000, {
        resumed: false,
        replayed: 0,
        gap: "buffer-evicted",
      });

      expect(frame.data).toMatchObject({ resumed: false, gap: "buffer-evicted" });
    });
  });

  describe("closingFrame", () => {
    it("is visible, unlike the heartbeat — the client needs to know it was not the network", () => {
      const rendered = render(closingFrame(EPOCH, 4));

      expect(rendered).toContain("event: stream.closing\n");
      expect(rendered).toContain(`id: ${EPOCH}.4\n`);
      expect(rendered).toContain('data: {"reason":"shutdown"}\n');
    });
  });
});
