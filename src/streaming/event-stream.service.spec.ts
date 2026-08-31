import { ServiceUnavailableException, type MessageEvent } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Role } from "@prisma/client";
import { firstValueFrom } from "rxjs";
import type { Subscription } from "rxjs";
import type { DomainEvent } from "@/events";
import {
  EventStreamHub,
  eventStreamOptionsFrom,
  type EventStreamOptions,
} from "./event-stream.service";
import { parseCursor } from "./stream-cursor";
import type { StreamAudience, StreamOpenPayload } from "./index";

const OPTIONS: EventStreamOptions = {
  heartbeatIntervalMs: 1_000,
  replayBufferSize: 4,
  maxConnections: 2,
  retryHintMs: 3_000,
};

const admin: StreamAudience = { id: "admin-1", role: Role.ADMIN };
const erin: StreamAudience = { id: "user-1", role: Role.USER };

const registration = (userId: string, id = `evt-${userId}`): DomainEvent<"user.registered"> => ({
  id,
  name: "user.registered",
  occurredAt: "2026-01-01T00:00:00.000Z",
  correlationId: null,
  payload: { userId, email: `${userId}@example.com`, name: null, provider: null },
});

/** Collects frames as they are written, the way Nest's SSE handler consumes one. */
class Collector {
  readonly frames: MessageEvent[] = [];
  readonly subscription: Subscription;
  completed = false;
  error: unknown = null;

  constructor(stream: ReturnType<EventStreamHub["connect"]>) {
    this.subscription = stream.subscribe({
      next: (frame) => this.frames.push(frame),
      error: (caught: unknown) => {
        this.error = caught;
      },
      complete: () => {
        this.completed = true;
      },
    });
  }

  types(): string[] {
    return this.frames.map((frame) => frame.type ?? "message");
  }

  open(): StreamOpenPayload {
    return this.frames[0]!.data as StreamOpenPayload;
  }

  /** Every domain-event frame, ignoring the control frames around them. */
  events(): MessageEvent[] {
    return this.frames.filter((frame) => !(frame.type ?? "").startsWith("stream."));
  }

  last(): MessageEvent {
    return this.frames[this.frames.length - 1]!;
  }
}

describe("EventStreamHub", () => {
  let hub: EventStreamHub;

  beforeEach(() => {
    jest.useFakeTimers();
    hub = new EventStreamHub(OPTIONS);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe("options", () => {
    it("reads its settings from configuration, falling back to the documented defaults", () => {
      const config = new ConfigService({ SSE_HEARTBEAT_INTERVAL_MS: 250 });

      expect(eventStreamOptionsFrom(config)).toEqual({
        heartbeatIntervalMs: 250,
        replayBufferSize: 1_024,
        maxConnections: 1_000,
        retryHintMs: 3_000,
      });
    });
  });

  describe("opening a stream", () => {
    it("sends stream.open first, with the retry hint and the current cursor", () => {
      const client = new Collector(hub.connect(admin));

      expect(client.frames).toHaveLength(1);
      expect(client.frames[0]!.type).toBe("stream.open");
      expect(client.frames[0]!.retry).toBe(3_000);
      expect(client.open()).toEqual({
        epoch: expect.stringMatching(/^[0-9a-f]{32}$/) as unknown as string,
        cursor: hub.currentCursor(),
        resumed: false,
        replayed: 0,
        gap: null,
      });
    });

    /**
     * A fresh connection is caught up to *now*, not to the beginning of the
     * buffer. Anchoring it at position 0 would mean that a client which
     * connected, saw nothing and reconnected would be replayed the entire
     * backlog of events it had already decided it did not want.
     */
    it("anchors a first connection at the current position, not at the buffer's start", () => {
      hub.onUserRegistered(registration("user-1"));
      hub.onUserRegistered(registration("user-2"));

      const client = new Collector(hub.connect(admin));

      expect(client.open().cursor).toBe(hub.currentCursor());
      expect(client.events()).toHaveLength(0);
    });
  });

  describe("live delivery", () => {
    it("delivers events published after the connection opened", () => {
      const client = new Collector(hub.connect(admin));
      hub.onUserRegistered(registration("user-1"));

      expect(client.events()).toHaveLength(1);
      expect(client.events()[0]!.type).toBe("user.registered");
    });

    it("advances the cursor on the frame id so a client always holds a resume point", () => {
      const client = new Collector(hub.connect(admin));
      hub.onUserRegistered(registration("user-1"));
      hub.onUserRegistered(registration("user-2"));

      expect(client.events().map((frame) => parseCursor(frame.id)?.seq)).toEqual([1, 2]);
    });

    it("delivers user.deleted as well as user.registered", () => {
      const client = new Collector(hub.connect(admin));
      hub.onUserDeleted({
        id: "evt-d",
        name: "user.deleted",
        occurredAt: "2026-01-01T00:00:00.000Z",
        correlationId: null,
        payload: { userId: "user-1", email: "erin@example.com" },
      });

      expect(client.events()[0]!.type).toBe("user.deleted");
    });

    it("filters events the connection is not allowed to see", () => {
      const client = new Collector(hub.connect(erin));
      hub.onUserRegistered(registration("user-2"));
      hub.onUserRegistered(registration("user-1"));

      expect(client.events()).toHaveLength(1);
      expect((client.events()[0]!.data as { payload: { userId: string } }).payload.userId).toBe(
        "user-1",
      );
    });

    it("gives two connections the same events without interfering", () => {
      const one = new Collector(hub.connect(admin));
      const two = new Collector(hub.connect(admin));
      hub.onUserRegistered(registration("user-1"));

      expect(one.events()).toHaveLength(1);
      expect(two.events()).toHaveLength(1);
    });
  });

  describe("resume", () => {
    it("replays everything after a cursor it issued", () => {
      const first = new Collector(hub.connect(admin));
      hub.onUserRegistered(registration("user-1"));
      hub.onUserRegistered(registration("user-2"));
      const cursor = first.last().id!;
      first.subscription.unsubscribe();

      hub.onUserRegistered(registration("user-3"));
      hub.onUserRegistered(registration("user-4"));

      const resumed = new Collector(hub.connect(admin, cursor));

      expect(resumed.open()).toMatchObject({ resumed: true, replayed: 2, gap: null });
      expect(resumed.events().map((frame) => (frame.data as { id: string }).id)).toEqual([
        "evt-user-3",
        "evt-user-4",
      ]);
    });

    /**
     * The window closes over the replay: an event published between the moment
     * the backlog is read and the moment the live subject is subscribed would
     * be in neither, and would be lost with no gap reported — the worst
     * available outcome, since the client is told it resumed cleanly. `connect`
     * closes it by snapshotting inside `defer` and joining with `concat` over a
     * synchronous source, so both happen in one tick.
     */
    it("loses nothing between the backlog and the live stream", () => {
      const first = new Collector(hub.connect(admin));
      hub.onUserRegistered(registration("user-1"));
      const cursor = first.last().id!;
      first.subscription.unsubscribe();

      hub.onUserRegistered(registration("user-2"));

      const stream = hub.connect(admin, cursor);
      // Publishing between building the observable and subscribing to it is the
      // race: a snapshot taken when `connect` was *called* would miss this one.
      hub.onUserRegistered(registration("user-3"));

      const resumed = new Collector(stream);

      expect(resumed.events().map((frame) => (frame.data as { id: string }).id)).toEqual([
        "evt-user-2",
        "evt-user-3",
      ]);
    });

    it("reports a cursor from another process rather than replaying its own events", () => {
      hub.onUserRegistered(registration("user-1"));
      const otherProcess = `${"a".repeat(32)}.0`;

      const client = new Collector(hub.connect(admin, otherProcess));

      expect(client.open()).toMatchObject({ resumed: false, replayed: 0, gap: "epoch-changed" });
      expect(client.events()).toHaveLength(0);
    });

    it("reports a cursor older than the buffer still holds", () => {
      const first = new Collector(hub.connect(admin));
      hub.onUserRegistered(registration("user-1"));
      const cursor = first.last().id!;
      first.subscription.unsubscribe();

      // Capacity is 4, so events 2–6 evict everything up to and including 2.
      for (let i = 2; i <= 6; i += 1) hub.onUserRegistered(registration(`user-${i}`));

      const client = new Collector(hub.connect(admin, cursor));

      expect(client.open()).toMatchObject({ gap: "buffer-evicted", replayed: 0 });
    });

    /** The boundary: the oldest retained entry is the one *after* this cursor. */
    it("still resumes from the last position the buffer can serve in full", () => {
      const first = new Collector(hub.connect(admin));
      hub.onUserRegistered(registration("user-1"));
      const cursor = first.last().id!;
      first.subscription.unsubscribe();

      // Capacity 4: after five events the buffer holds 2–5, so a cursor at 1 is
      // exactly served.
      for (let i = 2; i <= 5; i += 1) hub.onUserRegistered(registration(`user-${i}`));

      const client = new Collector(hub.connect(admin, cursor));

      expect(client.open()).toMatchObject({ gap: null, resumed: true, replayed: 4 });
    });

    it.each([
      ["a malformed cursor", "not-a-cursor", "malformed-cursor"],
      ["a blank cursor", "   ", "no-cursor"],
    ])("reports %s", (_label, cursor, gap) => {
      const client = new Collector(hub.connect(admin, cursor));

      expect(client.open().gap).toBe(gap === "no-cursor" ? null : gap);
    });

    it("reports a cursor ahead of anything it has issued", () => {
      const ahead = `${hub.currentCursor().split(".")[0]!}.500`;

      expect(new Collector(hub.connect(admin, ahead)).open().gap).toBe("cursor-ahead");
    });

    /**
     * Replay is filtered by the same rule as live delivery. A backlog served
     * verbatim would be the exact leak `isVisibleTo` exists to prevent, reached
     * by reconnecting rather than by staying connected.
     */
    it("applies visibility to replayed events too", () => {
      const first = new Collector(hub.connect(erin));
      const cursor = first.last().id!;
      first.subscription.unsubscribe();

      hub.onUserRegistered(registration("user-2"));
      hub.onUserRegistered(registration("user-1"));

      const resumed = new Collector(hub.connect(erin, cursor));

      expect(resumed.open().replayed).toBe(2);
      expect(resumed.events()).toHaveLength(1);
      expect((resumed.events()[0]!.data as { id: string }).id).toBe("evt-user-1");
    });
  });

  describe("heartbeat", () => {
    it("sends a keep-alive once the interval elapses", () => {
      const client = new Collector(hub.connect(admin));

      jest.advanceTimersByTime(1_000);

      expect(client.types()).toEqual(["stream.open", "stream.heartbeat"]);
      expect(client.last().data).toBe("");
    });

    it("keeps sending them", () => {
      const client = new Collector(hub.connect(admin));

      jest.advanceTimersByTime(3_000);

      expect(client.types().filter((type) => type === "stream.heartbeat")).toHaveLength(3);
    });

    it("carries the position of the last event the connection processed", () => {
      const client = new Collector(hub.connect(admin));
      hub.onUserRegistered(registration("user-1"));
      hub.onUserRegistered(registration("user-2"));

      jest.advanceTimersByTime(1_000);

      expect(parseCursor(client.last().id)?.seq).toBe(2);
    });

    /**
     * Advancing past an event the connection was not shown is deliberate.
     * Holding the cursor back at the last *visible* event would make every
     * reconnect re-request a backlog that is then filtered away again — and on
     * a stream where a user sees few of the events flowing through it, that
     * backlog is most of the buffer, every time.
     */
    it("advances past events that were filtered out", () => {
      const client = new Collector(hub.connect(erin));
      hub.onUserRegistered(registration("user-2"));
      hub.onUserRegistered(registration("user-3"));

      jest.advanceTimersByTime(1_000);

      expect(client.events()).toHaveLength(0);
      expect(parseCursor(client.last().id)?.seq).toBe(2);
    });

    it("stops when the client disconnects", () => {
      const client = new Collector(hub.connect(admin));
      client.subscription.unsubscribe();

      jest.advanceTimersByTime(5_000);

      expect(client.types()).toEqual(["stream.open"]);
    });
  });

  describe("connection cap", () => {
    it("refuses a connection over the limit with a 503", () => {
      new Collector(hub.connect(admin));
      new Collector(hub.connect(admin));

      const rejected = new Collector(hub.connect(admin));

      expect(rejected.error).toBeInstanceOf(ServiceUnavailableException);
      expect(rejected.frames).toHaveLength(0);
    });

    /**
     * The cleanup requirement, stated as the failure it prevents: a slot that is
     * taken and never given back makes the endpoint answer 503 to everybody
     * until the next deploy, and it takes exactly `maxConnections` disconnects
     * to get there.
     */
    it("releases the slot when the client disconnects", () => {
      const first = new Collector(hub.connect(admin));
      new Collector(hub.connect(admin));
      expect(hub.openConnections).toBe(2);

      first.subscription.unsubscribe();
      expect(hub.openConnections).toBe(1);

      expect(new Collector(hub.connect(admin)).error).toBeNull();
      expect(hub.openConnections).toBe(2);
    });

    it("does not consume a slot for a connection it refused", () => {
      const first = new Collector(hub.connect(admin));
      new Collector(hub.connect(admin));
      new Collector(hub.connect(admin));

      first.subscription.unsubscribe();

      expect(hub.openConnections).toBe(1);
    });
  });

  describe("shutdown", () => {
    it("says goodbye and completes every open stream", () => {
      const client = new Collector(hub.connect(admin));

      hub.onApplicationShutdown();

      expect(client.last().type).toBe("stream.closing");
      expect(client.last().data).toEqual({ reason: "shutdown" });
      expect(client.completed).toBe(true);
    });

    /**
     * The heartbeat timer holds the event loop open for the life of a
     * connection, so a shutdown that did not unsubscribe it would wait on
     * connections designed never to end — until `main.ts` gave up and killed
     * the process at ten seconds, taking whatever else was still draining with
     * it.
     */
    it("releases the heartbeat timers, so nothing keeps the process alive", () => {
      new Collector(hub.connect(admin));
      new Collector(hub.connect(admin));

      hub.onApplicationShutdown();

      expect(hub.openConnections).toBe(0);
      expect(jest.getTimerCount()).toBe(0);
    });

    it("is harmless with nothing connected", () => {
      expect(() => hub.onApplicationShutdown()).not.toThrow();
    });
  });

  describe("as a bus subscriber", () => {
    it("records an event even with nobody connected, so a later resume can find it", async () => {
      hub.onUserRegistered(registration("user-1"));

      const client = hub.connect(admin, `${hub.currentCursor().split(".")[0]!}.0`);
      const first = await firstValueFrom(client);

      expect((first.data as StreamOpenPayload).replayed).toBe(1);
    });
  });
});
