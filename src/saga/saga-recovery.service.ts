import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { randomUUID } from "crypto";
import { SagaOrchestrator } from "./saga-orchestrator.service";
import { SagaRegistry } from "./saga-registry";
import type { SagaInstanceRecord } from "./saga-instance";
import { SAGA_STORE, type SagaStore } from "./ports";

/** What one recovery pass did. */
export interface RecoveryReport {
  readonly claimed: number;
  readonly advanced: readonly { readonly id: string; readonly status: string }[];
}

/**
 * The half of the saga machinery that makes it durable rather than merely
 * persistent.
 *
 * Without it a saga advances only while the request that started it is still
 * running, and every failure mode that matters is a failure mode where it is
 * not: the process is redeployed between the charge and the shipment, the step
 * fails transiently and asks to be retried in four seconds, the pod is
 * evicted mid-compensation. All of those leave a row that is due, unleased and
 * unfinished — which is exactly what this claims.
 *
 * It is `OutboxRelayService` with the lock swapped for a lease and the publish
 * swapped for an advance, down to the one-pass-at-a-time discipline and the
 * shutdown that waits rather than cuts. What it does *not* copy is the outbox's
 * transaction held across the network call, and `SagaStore` says why.
 */
@Injectable()
export class SagaRecoveryService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(SagaRecoveryService.name);

  private readonly enabled: boolean;
  private readonly intervalMs: number;
  private readonly batchSize: number;
  private readonly leaseMs: number;

  private timer: NodeJS.Timeout | null = null;
  private stopped = false;
  /** The pass in flight, so shutdown waits for it instead of abandoning leases. */
  private inFlight: Promise<unknown> = Promise.resolve();

  constructor(
    @Inject(SAGA_STORE) private readonly store: SagaStore,
    private readonly orchestrator: SagaOrchestrator,
    private readonly registry: SagaRegistry,
    config: ConfigService,
  ) {
    this.enabled = config.get<boolean>("SAGA_RECOVERY_ENABLED", true);
    this.intervalMs = config.get<number>("SAGA_POLL_INTERVAL_MS", 1_000);
    this.batchSize = config.get<number>("SAGA_RECOVERY_BATCH_SIZE", 20);
    this.leaseMs = config.get<number>("SAGA_LEASE_MS", 30_000);
  }

  onApplicationBootstrap(): void {
    if (!this.enabled) {
      this.logger.warn(
        "Saga recovery is disabled (SAGA_RECOVERY_ENABLED=false). A saga interrupted between " +
          "two steps will stay where it stopped until something advances it.",
      );
      return;
    }
    this.logger.log(
      `Saga recovery polling every ${this.intervalMs}ms, up to ${this.batchSize} instances ` +
        `per pass, for [${this.registry.names().join(", ")}].`,
    );
    this.scheduleNext();
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    // A pass in flight holds leases. Letting it finish releases them the moment
    // each saga settles; killing it leaves every claimed instance frozen until
    // its lease expires, which is the difference between a rolling deploy that
    // is invisible and one that stalls every checkout for half a minute.
    await this.inFlight;
  }

  /**
   * Runs exactly one pass and reports it.
   *
   * Public for the same reason the relay's `runOnce` is: a test wants a
   * deterministic pass rather than a timer, and a deployment that would rather
   * drive recovery from a scheduler than from a `setTimeout` has something to
   * call. Safe to run concurrently with the timer — the claim is atomic, so two
   * passes take disjoint batches.
   */
  async runOnce(now: Date = new Date()): Promise<RecoveryReport> {
    const owner = randomUUID();
    const claimed = await this.store.claimDue(
      { owner, now, leaseMs: this.leaseMs },
      this.batchSize,
    );
    const advanced: { id: string; status: string }[] = [];

    for (const instance of claimed) {
      advanced.push(await this.advanceOne(instance, owner));
    }

    return { claimed: claimed.length, advanced };
  }

  private async advanceOne(
    instance: SagaInstanceRecord,
    owner: string,
  ): Promise<{ id: string; status: string }> {
    try {
      const settled = await this.orchestrator.advanceClaimed(instance, owner);
      return { id: settled.id, status: settled.status };
    } catch (caught: unknown) {
      // The orchestrator handles a *step* failing; reaching here means the
      // machinery itself did — a store that cannot be written to, most likely.
      // The lease expires on its own and the instance is due again, so the pass
      // carries on with the rest of the batch rather than losing it to one bad
      // saga.
      const message = caught instanceof Error ? caught.message : String(caught);
      this.logger.error(`Saga ${instance.id} (${instance.name}) could not be advanced: ${message}`);
      return { id: instance.id, status: instance.status };
    }
  }

  private scheduleNext(): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.inFlight = this.tick();
      void this.inFlight;
    }, this.intervalMs);
    // A poll every second must not keep an otherwise idle process alive, for
    // the same reason `RealtimeGateway`'s sweep and the lock clock's timers are
    // unreferenced: it would turn every clean shutdown into the force-exit in
    // main.ts.
    this.timer.unref?.();
  }

  private async tick(): Promise<void> {
    try {
      const report = await this.runOnce();
      if (report.claimed > 0) {
        this.logger.debug(
          `Recovered ${report.claimed} saga(s): ` +
            report.advanced.map((item) => `${item.id}→${item.status}`).join(", "),
        );
      }
    } catch (caught: unknown) {
      const message = caught instanceof Error ? caught.message : String(caught);
      this.logger.error(`Saga recovery pass failed: ${message}`);
    } finally {
      // The next pass is scheduled once this one has settled, never on a fixed
      // interval: a pass that outruns the interval would otherwise start a
      // second one that competes with it for the same connections.
      this.scheduleNext();
    }
  }
}
