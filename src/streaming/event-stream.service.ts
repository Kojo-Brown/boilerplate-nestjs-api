import {
  Injectable,
  Logger,
  ServiceUnavailableException,
  type MessageEvent,
  type OnApplicationShutdown,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { randomUUID } from "crypto";
import { ReplaySubject, Subject, concat, defer, from, merge, of, throwError, timer } from "rxjs";
import { filter, finalize, map, take, takeUntil } from "rxjs/operators";
import type { Observable } from "rxjs";
import { OnDomainEvent, type AnyDomainEvent, type DomainEvent } from "@/events";
import { ReplayBuffer } from "./replay-buffer";
import { formatCursor, parseCursor } from "./stream-cursor";
import {
  closingFrame,
  eventFrame,
  heartbeatFrame,
  openFrame,
  type ResumeGap,
} from "./stream-frames";
import { isVisibleTo, type StreamAudience } from "./stream-visibility";

/** One event with the position this process assigned it. */
interface SequencedEvent {
  readonly seq: number;
  readonly event: AnyDomainEvent;
}

/** What {@link EventStreamHub.resolveResume} decided about a client's cursor. */
interface Resume {
  /** The position to stream from. Events strictly after it are delivered. */
  readonly from: number;
  readonly backlog: readonly SequencedEvent[];
  readonly gap: ResumeGap | null;
}

export interface EventStreamOptions {
  readonly heartbeatIntervalMs: number;
  readonly replayBufferSize: number;
  readonly maxConnections: number;
  readonly retryHintMs: number;
}

export function eventStreamOptionsFrom(config: ConfigService): EventStreamOptions {
  return {
    heartbeatIntervalMs: config.get<number>("SSE_HEARTBEAT_INTERVAL_MS", 15_000),
    replayBufferSize: config.get<number>("SSE_REPLAY_BUFFER_SIZE", 1_024),
    maxConnections: config.get<number>("SSE_MAX_CONNECTIONS", 1_000),
    retryHintMs: config.get<number>("SSE_RETRY_HINT_MS", 3_000),
  };
}

/**
 * Fans the domain event bus out to connected Server-Sent Events clients.
 *
 * It is a subscriber like any other — `@OnDomainEvent` methods, discovered by
 * the same loader — which is what makes it work across replicas without knowing
 * that it does: `DomainEventConsumer` puts what it reads off the Kafka topic
 * onto the same bus, so an event produced by another instance arrives here
 * indistinguishably from a local one. Nothing in this file mentions a broker.
 *
 * ### The three things this endpoint has to get right
 *
 * **Heartbeat.** An idle SSE connection is indistinguishable from a dead one to
 * every intermediary between the client and this process, and the usual ones
 * close it somewhere between 30 and 60 seconds. The client then reconnects,
 * which is survivable, but a stream that only ever reconnects is one that
 * delivers nothing. {@link import("./stream-frames").heartbeatFrame} keeps the
 * socket warm without being visible to the client.
 *
 * **Resume.** `EventSource` reconnects on its own and sends `Last-Event-ID`,
 * and a server that ignores it silently drops every event that happened during
 * the gap. See {@link ReplayBuffer} for what can be replayed and
 * {@link import("./stream-cursor").StreamCursor} for how a cursor that *cannot*
 * be honoured is detected rather than misread.
 *
 * **Cleanup.** Every connection holds a socket, a subscription to a hot
 * `Subject`, an interval timer, and a slot against `SSE_MAX_CONNECTIONS`. All
 * four are released by the one `finalize` below, which runs whether the client
 * disconnected, the process is shutting down, or the observable errored. A leak
 * here is not a slow degradation: the connection cap is a hard limit, so a
 * counter that only ever goes up means the endpoint starts answering 503 to
 * everybody and keeps doing it until the next deploy.
 */
@Injectable()
export class EventStreamHub implements OnApplicationShutdown {
  private readonly logger = new Logger(EventStreamHub.name);

  /**
   * This process's identity, minted once.
   *
   * Dashes are stripped so the cursor's two parts are separated by the only dot
   * in it, and `parseCursor` can be a single anchored pattern.
   */
  private readonly epoch = randomUUID().replaceAll("-", "");

  private readonly buffer: ReplayBuffer<SequencedEvent>;
  private readonly live = new Subject<SequencedEvent>();

  /**
   * A `ReplaySubject` rather than a `Subject`, and that is load-bearing.
   *
   * Shutdown has to do two things in sequence — stop the live stream, then send
   * the farewell — and with a plain `Subject` the second subscriber (the one
   * that renders {@link closingFrame}) subscribes only *after* `takeUntil` has
   * already completed the first, by which time the signal has been and gone and
   * the client is disconnected with no explanation. Replaying the one value
   * makes the late subscription see it.
   */
  private readonly stopping = new ReplaySubject<void>(1);

  private seq = 0;
  private open = 0;

  constructor(private readonly options: EventStreamOptions) {
    this.buffer = new ReplayBuffer<SequencedEvent>(options.replayBufferSize);
  }

  /** How many streams are currently connected. Exposed for tests and operational logging. */
  get openConnections(): number {
    return this.open;
  }

  @OnDomainEvent("user.registered")
  onUserRegistered(event: DomainEvent<"user.registered">): void {
    this.record(event);
  }

  @OnDomainEvent("user.deleted")
  onUserDeleted(event: DomainEvent<"user.deleted">): void {
    this.record(event);
  }

  /**
   * Opens a stream for one authenticated caller.
   *
   * Everything happens inside `defer`, so the backlog is snapshotted when Nest
   * subscribes rather than when the controller returns. Those are different
   * moments — Nest subscribes in a later microtask — and taking the snapshot at
   * the earlier one would drop any event that arrived in between.
   *
   * The backlog and the live subject are joined with `concat` rather than
   * merged, which is what closes the same race at the other end: `from` over an
   * array emits and completes synchronously, so `concat` subscribes to
   * {@link live} in the same tick as the snapshot was taken. There is no window
   * in which an event is in neither.
   */
  connect(audience: StreamAudience, lastEventId?: string): Observable<MessageEvent> {
    return defer((): Observable<MessageEvent> => {
      if (this.open >= this.options.maxConnections) {
        // Thrown before a byte is written, so Nest's SSE handler has not
        // committed headers yet and this reaches `AllExceptionsFilter` as an
        // ordinary 503 rather than as an `event: error` frame on a stream the
        // client thinks succeeded.
        return throwError(
          () =>
            new ServiceUnavailableException(
              `Event stream is at capacity (${this.options.maxConnections} connections)`,
            ),
        );
      }

      this.open += 1;

      const resume = this.resolveResume(lastEventId);
      if (resume.gap && resume.gap !== "no-cursor") {
        this.logger.warn(
          `Stream for user ${audience.id} could not resume from "${lastEventId ?? ""}": ${resume.gap}`,
        );
      }

      // The highest position this connection has *processed*. Advanced for
      // every event that passes through, including ones filtered out below, so
      // that a heartbeat moves the client past events it was never going to be
      // shown rather than making it ask for them again on every reconnect.
      let cursor = resume.from;

      const events$ = concat(from(resume.backlog), this.live).pipe(
        map((entry) => {
          cursor = entry.seq;
          return entry;
        }),
        filter((entry) => isVisibleTo(entry.event, audience)),
        map((entry) => eventFrame(this.epoch, entry.seq, entry.event)),
      );

      // Read at emission time, and that is exactly why it is correct: RxJS
      // operators run synchronously as a value passes, `merge` preserves the
      // order its sources emitted in, and the `concatMap` Nest wraps this in
      // writes in that same order. So a heartbeat's cursor reflects every event
      // emitted before it and none emitted after — never one still queued.
      const heartbeats$ = timer(
        this.options.heartbeatIntervalMs,
        this.options.heartbeatIntervalMs,
      ).pipe(map(() => heartbeatFrame(this.epoch, cursor)));

      const opening$ = of(
        openFrame(this.epoch, resume.from, this.options.retryHintMs, {
          resumed: resume.gap === null,
          replayed: resume.backlog.length,
          gap: resume.gap === "no-cursor" ? null : resume.gap,
        }),
      );

      const farewell$ = this.stopping.pipe(
        take(1),
        map(() => closingFrame(this.epoch, cursor)),
      );

      return concat(
        opening$,
        merge(events$, heartbeats$).pipe(takeUntil(this.stopping)),
        farewell$,
      ).pipe(
        finalize(() => {
          this.open -= 1;
        }),
      );
    });
  }

  /**
   * Completes every open stream so the process can exit.
   *
   * Without this a shutdown waits on connections that are, by design, never
   * going to end: each holds a heartbeat timer that keeps the event loop alive,
   * so `app.close()` would hang until the 10-second force-exit in `main.ts`
   * killed it — turning every rolling deploy into a hard kill of whatever else
   * was still draining. Signalling instead lets `takeUntil` unsubscribe the
   * timers, `finalize` release the slots, and Nest end each response.
   */
  onApplicationShutdown(): void {
    if (this.open > 0) {
      this.logger.log(`Closing ${this.open} open event stream(s)`);
    }
    this.stopping.next();
  }

  private record(event: AnyDomainEvent): void {
    this.seq += 1;
    const entry: SequencedEvent = { seq: this.seq, event };
    // Buffered before it is published, so a client connecting in the same tick
    // finds it in the backlog rather than in neither place.
    this.buffer.append(entry);
    this.live.next(entry);
  }

  private resolveResume(lastEventId?: string): Resume {
    const live = (gap: ResumeGap): Resume => ({ from: this.seq, backlog: [], gap });

    if (lastEventId === undefined || lastEventId.trim() === "") return live("no-cursor");

    const cursor = parseCursor(lastEventId);
    if (!cursor) return live("malformed-cursor");
    if (cursor.epoch !== this.epoch) return live("epoch-changed");
    if (cursor.seq > this.seq) return live("cursor-ahead");

    const oldest = this.buffer.oldestSeq;
    // `oldest - 1` is the newest position a client can hold and still be served
    // in full: the buffer's first entry is the one immediately after it.
    if (oldest !== null && cursor.seq < oldest - 1) return live("buffer-evicted");

    return { from: cursor.seq, backlog: this.buffer.since(cursor.seq), gap: null };
  }

  /** The cursor a fresh connection would be given. Exposed for tests and logs. */
  currentCursor(): string {
    return formatCursor(this.epoch, this.seq);
  }
}
