import {
  Inject,
  Injectable,
  Logger,
  Optional,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { Counter } from "@opentelemetry/api";
import { meterFor } from "@/telemetry";
import { ATTR_APP_EVENT_NAME, ATTR_APP_OUTBOX_DISPOSITION } from "@/telemetry/semconv";
import type { DrainReport, OutboxRecord } from "./outbox-record";
import { OUTBOX_PUBLISHER, OUTBOX_STORE, type OutboxPublisher, type OutboxStore } from "./ports";
import { nextAttemptAt, type BackoffPolicy } from "@/common/backoff";
import { PublishTimeoutError } from "./outbox.errors";

/** Optional DI token for the relay's jitter source. See the constructor. */
export const OUTBOX_JITTER = Symbol("OUTBOX_JITTER");

/**
 * The polling publisher.
 *
 * Every tick it asks the store for the rows nobody else holds, hands each to
 * the broker, and records what happened — all inside the store's transaction,
 * so a relay that dies mid-batch leaves the rows exactly as due as they were.
 * Nothing here knows any SQL and nothing here knows any broker; both are behind
 * ports, which is what makes the retry policy testable without either.
 *
 * Polling, rather than reading the WAL. Change-data capture (Debezium and
 * friends) removes the poll latency and the load, at the cost of an operational
 * dependency this repository does not have. `docs/outbox.md` compares them.
 *
 * ### Overlap, and why one tick at a time
 *
 * A tick that outruns the interval must not start a second one. Two concurrent
 * drains in the same process would not double-publish — `SKIP LOCKED` sees to
 * that — but they would compete for connections from the same small pool while
 * the first one holds a transaction open, which is how a slow broker turns into
 * a failing API. The interval schedules the *next* tick only once the current
 * one has settled.
 */
@Injectable()
export class OutboxRelayService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(OutboxRelayService.name);
  /**
   * Rows the relay finished with, by disposition and event name.
   *
   * The one number an operator needs from the outbox that the logs do not
   * already give them: `disposition="dead"` climbing above zero means events
   * were given up on, and it is the only outbox failure that is silent
   * otherwise — a `retry` eventually publishes or becomes a `dead`, but a dead
   * letter just sits in the table.
   *
   * A counter rather than a gauge of the pending backlog, because the backlog
   * is a `SELECT count(*)` over a table this relay is deliberately never
   * allowed to scan on a timer (see `countByStatus`). Rate of change is what
   * an alert wants anyway.
   */
  private readonly outcomes: Counter = meterFor("outbox").createCounter("outbox.events.drained", {
    description: "Outbox rows the relay finished with, by disposition.",
    unit: "{event}",
  });

  private readonly enabled: boolean;
  private readonly intervalMs: number;
  private readonly batchSize: number;
  private readonly publishTimeoutMs: number;
  private readonly policy: BackoffPolicy;

  private timer: NodeJS.Timeout | null = null;
  private stopped = false;
  /** The tick in flight, so shutdown can wait for it rather than cutting it off. */
  private inFlight: Promise<unknown> = Promise.resolve();

  constructor(
    @Inject(OUTBOX_STORE) private readonly store: OutboxStore,
    @Inject(OUTBOX_PUBLISHER) private readonly publisher: OutboxPublisher,
    config: ConfigService,
    /**
     * The jitter source, bound to `Math.random` unless something supplies one.
     *
     * A token rather than a default parameter, because Nest resolves every
     * constructor argument from design-time metadata and would try to inject a
     * provider called `Function`. Optional for the same reason the fake clocks
     * elsewhere in this repository are: nothing in production binds it, and a
     * test that wants a schedule it can assert on does.
     */
    @Optional() @Inject(OUTBOX_JITTER) private readonly random: () => number = Math.random,
  ) {
    this.enabled = config.get<boolean>("OUTBOX_RELAY_ENABLED", true);
    this.intervalMs = config.get<number>("OUTBOX_POLL_INTERVAL_MS", 1_000);
    this.batchSize = config.get<number>("OUTBOX_BATCH_SIZE", 50);
    this.publishTimeoutMs = config.get<number>("OUTBOX_PUBLISH_TIMEOUT_MS", 5_000);
    this.policy = {
      baseMs: config.get<number>("OUTBOX_BACKOFF_BASE_MS", 500),
      maxMs: config.get<number>("OUTBOX_BACKOFF_MAX_MS", 300_000),
      maxAttempts: config.get<number>("OUTBOX_MAX_ATTEMPTS", 8),
    };
  }

  onApplicationBootstrap(): void {
    if (!this.enabled) {
      this.logger.log(
        "Outbox relay is disabled (OUTBOX_RELAY_ENABLED=false); nothing will be delivered.",
      );
      return;
    }
    this.logger.log(
      `Outbox relay polling every ${this.intervalMs}ms, up to ${this.batchSize} events per ` +
        `pass, publishing via ${this.publisher.name}.`,
    );
    this.scheduleNext();
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    // A drain in flight holds a transaction with rows locked in it. Letting it
    // finish releases them cleanly; tearing the process down instead leaves
    // Postgres to notice the dropped connection, and the rows stay claimed
    // until it does.
    await this.inFlight;
  }

  /**
   * Runs exactly one pass and reports it.
   *
   * Public because a test needs a deterministic drain rather than a timer, and
   * because a deployment that would rather trigger the relay from a scheduler
   * than from a timer has something to call. It is safe to call concurrently
   * with the timer — `SKIP LOCKED` means the two passes take disjoint batches.
   */
  async runOnce(now: Date = new Date()): Promise<DrainReport> {
    const report = await this.store.drain({
      now,
      batchSize: this.batchSize,
      deliver: (record) => this.deliver(record),
      retryAt: (record) => nextAttemptAt(now, record.attempts + 1, this.policy, this.random),
    });
    // Counted here rather than in `report()`, which only runs on the timer
    // path: a deployment that drives the relay from its own scheduler calls
    // this method directly, and its dead letters count for exactly as much.
    for (const outcome of report.outcomes) {
      this.outcomes.add(1, {
        [ATTR_APP_OUTBOX_DISPOSITION]: outcome.disposition,
        [ATTR_APP_EVENT_NAME]: outcome.name,
      });
    }
    return report;
  }

  /**
   * Publishes one record under a timeout.
   *
   * The timeout is what stops a broker that has stopped answering from holding
   * the drain transaction — and the row locks in it — until the transaction
   * timeout fires much later. What it does *not* do is cancel the publish: the
   * call carries on in the background, which is the ordinary limit of racing a
   * promise you did not create. That is the pessimistic side of at-least-once
   * delivery, and it is why the row is retried rather than dropped.
   */
  private async deliver(record: OutboxRecord): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        this.publisher.publish(record),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new PublishTimeoutError(record.eventId, this.publishTimeoutMs)),
            this.publishTimeoutMs,
          );
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private scheduleNext(): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.inFlight = this.tick();
      void this.inFlight;
    }, this.intervalMs);
    // The relay must never be the reason the process stays alive: an idle timer
    // holding the event loop open would make a finished CLI or a stopped test
    // suite hang for as long as the relay is enabled.
    this.timer.unref();
  }

  private async tick(): Promise<void> {
    try {
      const report = await this.runOnce();
      this.report(report);
    } catch (caught: unknown) {
      // Reaching here means the *drain* failed — the database is unreachable,
      // or the transaction timed out — not that an event failed, which the
      // store records per row. Nothing is lost either way: the transaction did
      // not commit, so every claimed row is still due.
      const message = caught instanceof Error ? caught.message : String(caught);
      this.logger.error(`Outbox drain failed; every claimed event is still pending: ${message}`);
    } finally {
      this.scheduleNext();
    }
  }

  private report(report: DrainReport): void {
    if (report.claimed === 0) return;

    const published = report.outcomes.filter((o) => o.disposition === "published").length;
    const retried = report.outcomes.filter((o) => o.disposition === "retry");
    const dead = report.outcomes.filter((o) => o.disposition === "dead");

    this.logger.log(
      `Outbox drain: ${published}/${report.claimed} published, ${retried.length} retrying, ` +
        `${dead.length} dead-lettered.`,
    );
    for (const outcome of retried) {
      this.logger.warn(
        `Outbox event ${outcome.eventId} (${outcome.name}) failed and retries at ` +
          `${outcome.nextAttemptAt?.toISOString() ?? "?"}: ${outcome.error ?? ""}`,
      );
    }
  }
}
