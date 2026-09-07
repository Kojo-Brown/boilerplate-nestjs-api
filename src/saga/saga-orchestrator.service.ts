import { Inject, Injectable, Logger, Optional } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { randomUUID } from "crypto";
import { nextAttemptAt, type BackoffPolicy } from "@/common/backoff";
import type { TransactionContext } from "@/common/prisma/transaction.port";
import { isTerminal } from "./saga-instance";
import type {
  SagaDirection,
  SagaInstanceRecord,
  SagaProgress,
  SagaStepLogEntry,
} from "./saga-instance";
import { SagaRegistry } from "./saga-registry";
import { SagaResumeError, SagaStepTimeoutError, UnretryableStepError } from "./saga.errors";
import type { SagaDefinition, SagaFailure, SagaStep, SagaStepContext } from "./saga-definition";
import type { JsonValue, SagaState } from "./saga-state";
import { SAGA_STORE, type SagaClaim, type SagaStore } from "./ports";

/** Optional DI token for the orchestrator's jitter source. Mirrors `OUTBOX_JITTER`. */
export const SAGA_JITTER = Symbol("SAGA_JITTER");

/** How a saga was started, for the log and for the events its steps stage. */
export interface StartSagaOptions {
  readonly correlationId?: string | null;
}

/**
 * Runs sagas, one step at a time, against a durable row.
 *
 * The whole design follows from one sentence: **there is no transaction that
 * spans a payment gateway and a database.** Everything else is a consequence.
 *
 * - The row is written *after* each step returns, in a transaction of its own,
 *   so a crash in that window re-runs the step. Steps are therefore idempotent
 *   on `context.idempotencyKey` — not as a nicety, but because the alternative
 *   is charging twice.
 * - Progress is one write per step rather than one at the end, so a process
 *   that dies mid-saga leaves a row that says exactly where it was.
 * - Failure runs the same list backwards, calling `compensate` on the steps
 *   that can be undone, until it reaches the beginning — or until the pivot,
 *   past which nothing may be undone and the only way out is forward.
 *
 * It is deliberately an **orchestrator** rather than a choreography of events:
 * the order of a checkout is a business rule that somebody has to be able to
 * read, and in a choreography it exists only as the union of five subscribers
 * in five modules. `docs/saga.md` argues both sides. The cost is that this
 * class is a coupling point, which is why it knows nothing about orders — it
 * takes definitions from `SagaRegistry` and state as JSON.
 */
@Injectable()
export class SagaOrchestrator {
  private readonly logger = new Logger(SagaOrchestrator.name);

  private readonly leaseMs: number;
  private readonly stepTimeoutMs: number;
  private readonly policy: BackoffPolicy;

  constructor(
    @Inject(SAGA_STORE) private readonly store: SagaStore,
    private readonly registry: SagaRegistry,
    config: ConfigService,
    @Optional() @Inject(SAGA_JITTER) private readonly random: () => number = Math.random,
  ) {
    this.leaseMs = config.get<number>("SAGA_LEASE_MS", 30_000);
    this.stepTimeoutMs = config.get<number>("SAGA_STEP_TIMEOUT_MS", 10_000);
    this.policy = {
      baseMs: config.get<number>("SAGA_BACKOFF_BASE_MS", 500),
      maxMs: config.get<number>("SAGA_BACKOFF_MAX_MS", 60_000),
      maxAttempts: config.get<number>("SAGA_MAX_ATTEMPTS", 6),
    };
  }

  /**
   * Starts a saga inside the caller's transaction.
   *
   * Nothing runs here. The row is written with the data that caused it — an
   * order and its saga commit together or not at all — and the first step waits
   * for {@link advance}, which the caller makes once the transaction has
   * committed. Running a step inside the transaction would hold it open across
   * a remote call, and a step that then failed would roll back the very row
   * that records the attempt.
   *
   * The name is checked against the registry here rather than at the first
   * advance, so a typo fails the request that made it instead of becoming a row
   * the poller refuses forever.
   */
  async start(
    tx: TransactionContext,
    name: string,
    state: SagaState,
    options: StartSagaOptions = {},
  ): Promise<SagaInstanceRecord> {
    this.registry.require(name);
    return this.store.create(tx, {
      id: randomUUID(),
      name,
      state,
      correlationId: options.correlationId ?? null,
    });
  }

  /**
   * Drives one saga as far as it will go right now, and reports where it got to.
   *
   * "As far as it will go" is bounded by design: the loop stops at a terminal
   * status, at a retry scheduled for later, and at a lost lease. It never
   * sleeps, so an advance is at most one pass of remote calls — which is what
   * makes it safe to call from a request path, where a checkout that succeeds
   * outright answers the caller with the finished order rather than a job id.
   *
   * Resolves with the instance as it now stands, whatever happened — including
   * when this runner could not claim it, which is the ordinary outcome when the
   * recovery poller got there first. The caller wants the state of the saga,
   * not the story of who advanced it.
   */
  async advance(id: string, now: Date = new Date()): Promise<SagaInstanceRecord | null> {
    const owner = randomUUID();
    const claimed = await this.store.claim(id, this.lease(owner, now));
    if (!claimed) return this.store.find(id);
    return this.drive(claimed, owner);
  }

  /**
   * Drives an instance the caller has already claimed.
   *
   * The recovery poller's entry point: it claims a batch in one statement and
   * would otherwise have to give each one back and take it again.
   */
  async advanceClaimed(claimed: SagaInstanceRecord, owner: string): Promise<SagaInstanceRecord> {
    return this.drive(claimed, owner);
  }

  private async drive(claimed: SagaInstanceRecord, owner: string): Promise<SagaInstanceRecord> {
    let current = claimed;

    // Every iteration either moves the cursor by one or ends the loop, so the
    // bound is the definition's length in each direction plus the two
    // transitions between them. It is a guard rather than a limit anything
    // reaches: a saga that hit it would be one whose store is not honouring the
    // cursor it was given, and spinning on that silently is worse than stopping.
    const definition = this.registry.find(current.name);
    if (!definition) {
      return this.abandon(current, `no definition named "${current.name}" is registered`);
    }
    const maxIterations = definition.steps.length * 2 + 2;

    for (let iteration = 0; iteration < maxIterations; iteration += 1) {
      if (isTerminal(current.status)) return current;

      let progress: SagaProgress;
      try {
        progress = await this.step(definition, current);
      } catch (caught: unknown) {
        // Only a saga that cannot be run at all reaches here — a cursor that no
        // longer names the step the log says ran there. Retrying it would fail
        // identically every time.
        return this.abandon(current, asError(caught).message);
      }

      const saved = await this.store.save(current.id, this.lease(owner, new Date()), progress);
      if (!saved) {
        // The lease moved on: this runner was slow, another took over, and
        // everything about to be written concerns a step the new owner has
        // already re-run. Stopping quietly is the whole point of the fencing
        // token — see `SagaStore.save`.
        this.logger.warn(
          `Saga ${current.id} (${current.name}) lost its lease mid-advance; another runner owns it.`,
        );
        return (await this.store.find(current.id)) ?? current;
      }

      current = saved;
      if (progress.release) return current;
    }

    this.logger.error(
      `Saga ${current.id} (${current.name}) did not settle in ${maxIterations} steps; stopping.`,
    );
    return current;
  }

  /** Decides, and performs, the one thing this saga does next. */
  private async step(
    definition: SagaDefinition<SagaState>,
    record: SagaInstanceRecord,
  ): Promise<SagaProgress> {
    assertResumable(definition, record);

    const backward = record.status === "COMPENSATING";
    const step = definition.steps[record.cursor];
    if (!step) {
      throw new SagaResumeError(
        record.id,
        `cursor ${record.cursor} is outside the ${definition.steps.length} steps of ` +
          `"${definition.name}"`,
      );
    }

    return backward
      ? this.compensateStep(definition, record, step)
      : this.executeStep(definition, record, step);
  }

  private async executeStep(
    definition: SagaDefinition<SagaState>,
    record: SagaInstanceRecord,
    step: SagaStep<SagaState>,
  ): Promise<SagaProgress> {
    const attempt = record.attempts + 1;
    const now = new Date();

    try {
      const patch = await this.call(step.name, () =>
        step.execute(this.context(record, step, undefined)),
      );
      const cursor = record.cursor + 1;
      const done = cursor >= definition.steps.length;
      return {
        status: done ? "COMPLETED" : "RUNNING",
        cursor,
        attempts: 0,
        nextAttemptAt: now,
        state: mergeState(record.state, patch),
        entry: entry(step.name, "forward", "completed", attempt, now),
        lastError: record.lastError,
        release: done,
      };
    } catch (caught: unknown) {
      const error = asError(caught);
      const retryAt = this.retryAt(now, attempt, error);

      if (retryAt) {
        this.logger.warn(
          `Saga ${record.id} step "${step.name}" failed (attempt ${attempt}), retrying at ` +
            `${retryAt.toISOString()}: ${error.message}`,
        );
        return {
          status: "RUNNING",
          cursor: record.cursor,
          attempts: attempt,
          nextAttemptAt: retryAt,
          state: record.state,
          entry: entry(step.name, "forward", "failed", attempt, now, error),
          lastError: truncate(error.message),
          release: true,
        };
      }

      // Out of attempts, or an error that will not become right by being
      // repeated. Which way the saga may now go is decided by where the step
      // sits relative to the pivot, and there is no third option: a step after
      // it has taken money and shipped goods, so backing out is not available
      // and a person has to look.
      if (step.kind === "retriable") {
        this.logger.error(
          `Saga ${record.id} is stuck at "${step.name}" after ${attempt} attempts. It is past ` +
            `the pivot and cannot be compensated: ${error.message}`,
        );
        return {
          status: "STUCK",
          cursor: record.cursor,
          attempts: attempt,
          nextAttemptAt: now,
          state: record.state,
          entry: entry(step.name, "forward", "failed", attempt, now, error),
          lastError: truncate(error.message),
          release: true,
        };
      }

      this.logger.warn(
        `Saga ${record.id} is compensating from "${step.name}" after ${attempt} ` +
          `attempt(s): ${error.message}`,
      );
      return {
        status: "COMPENSATING",
        // The failed step compensates too. It may have half-executed — an
        // authorisation taken and the response lost — and the only way to find
        // out is to ask, which is what its compensation does.
        cursor: record.cursor,
        attempts: 0,
        nextAttemptAt: now,
        state: record.state,
        entry: entry(step.name, "forward", "failed", attempt, now, error),
        lastError: truncate(error.message),
        release: false,
      };
    }
  }

  private async compensateStep(
    definition: SagaDefinition<SagaState>,
    record: SagaInstanceRecord,
    step: SagaStep<SagaState>,
  ): Promise<SagaProgress> {
    const attempt = record.attempts + 1;
    const now = new Date();
    const cursor = record.cursor - 1;
    const done = cursor < 0;

    if (step.kind !== "compensatable") {
      // The pivot. Nothing to undo, by definition rather than by omission — the
      // type system refused it a `compensate` — so this is a recorded skip
      // rather than a silent one.
      return {
        status: done ? "COMPENSATED" : "COMPENSATING",
        cursor,
        attempts: 0,
        nextAttemptAt: now,
        state: record.state,
        entry: entry(step.name, "backward", "skipped", attempt, now),
        lastError: record.lastError,
        release: done,
      };
    }

    try {
      await this.call(step.name, () =>
        step.compensate(this.context(record, step, failureFrom(definition, record))),
      );
      return {
        status: done ? "COMPENSATED" : "COMPENSATING",
        cursor,
        attempts: 0,
        nextAttemptAt: now,
        state: record.state,
        entry: entry(step.name, "backward", "completed", attempt, now),
        lastError: record.lastError,
        release: done,
      };
    } catch (caught: unknown) {
      const error = asError(caught);
      const retryAt = this.retryAt(now, attempt, error);

      if (retryAt) {
        this.logger.warn(
          `Saga ${record.id} compensation "${step.name}" failed (attempt ${attempt}), ` +
            `retrying at ${retryAt.toISOString()}: ${error.message}`,
        );
        return {
          status: "COMPENSATING",
          cursor: record.cursor,
          attempts: attempt,
          nextAttemptAt: retryAt,
          state: record.state,
          entry: entry(step.name, "backward", "failed", attempt, now, error),
          lastError: record.lastError,
          release: true,
        };
      }

      // A compensation that has run out of attempts is the worst state this
      // system has, and it is reported as such: the saga has decided against an
      // operation it has already performed and can no longer undo it. Marking
      // it `COMPENSATED` would be a lie, and continuing past it would undo the
      // steps *before* something that is still in place.
      this.logger.error(
        `Saga ${record.id} is stuck: compensation "${step.name}" failed ${attempt} times. ` +
          `Manual intervention required: ${error.message}`,
      );
      return {
        status: "STUCK",
        cursor: record.cursor,
        attempts: attempt,
        nextAttemptAt: now,
        state: record.state,
        entry: entry(step.name, "backward", "failed", attempt, now, error),
        // The compensation failure replaces the original reason, because it is
        // the one an operator has to act on. The reason the saga turned around
        // in the first place is still in the log.
        lastError: truncate(error.message),
        release: true,
      };
    }
  }

  /** When the step may next be tried, or `null` to stop trying. */
  private retryAt(now: Date, attempt: number, error: Error): Date | null {
    if (error instanceof UnretryableStepError) return null;
    return nextAttemptAt(now, attempt, this.policy, this.random);
  }

  private context(
    record: SagaInstanceRecord,
    step: SagaStep<SagaState>,
    failure: SagaFailure | undefined,
  ): SagaStepContext<SagaState> {
    return {
      sagaId: record.id,
      state: record.state,
      idempotencyKey: `${record.id}:${step.name}`,
      correlationId: record.correlationId,
      ...(failure ? { failure } : {}),
    };
  }

  /**
   * Bounds one step.
   *
   * The timeout stops the orchestrator *waiting*; it does not stop the step.
   * JavaScript has no cancellation, so a call that eventually answers does so
   * into a `then` nobody is listening to, while its side effect at the other
   * service happened anyway. That is precisely why `SAGA_LEASE_MS` must exceed
   * this — enforced in `env.schema.ts` — and why every participant is
   * idempotent on the step's key: a timed-out step is retried, and the retry
   * must not be a second charge.
   */
  private async call<T>(step: string, work: () => Promise<T>): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        work(),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new SagaStepTimeoutError(step, this.stepTimeoutMs)),
            this.stepTimeoutMs,
          );
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private lease(owner: string, now: Date): SagaClaim {
    return { owner, now, leaseMs: this.leaseMs };
  }

  private async abandon(record: SagaInstanceRecord, reason: string): Promise<SagaInstanceRecord> {
    this.logger.error(`Saga ${record.id} (${record.name}) cannot be advanced: ${reason}`);
    await this.store.abandon(record.id, "STUCK", truncate(reason));
    return (await this.store.find(record.id)) ?? record;
  }
}

/**
 * Refuses to resume an instance whose definition has moved underneath it.
 *
 * The cursor is a *position*, so a deploy that inserts, removes or reorders a
 * step changes what every running instance's cursor means — a saga that had
 * charged a card would resume into whatever now sits at index 2 and compensate
 * a payment by releasing stock. The log records names, so the two can be
 * checked: the i-th step this instance completed going forward must still be
 * the i-th step of the definition.
 *
 * Renaming a step is therefore a migration rather than a rename, which
 * `SagaStep.name` says. The check makes the consequence loud rather than
 * theoretical.
 */
export function assertResumable(
  definition: SagaDefinition<SagaState>,
  record: SagaInstanceRecord,
): void {
  const completed = record.log.filter(
    (item) => item.direction === "forward" && item.outcome === "completed",
  );

  completed.forEach((item, index) => {
    const expected = definition.steps[index]?.name;
    if (expected !== item.step) {
      throw new SagaResumeError(
        record.id,
        `it completed "${item.step}" at position ${index}, where "${definition.name}" now ` +
          `has ${expected ? `"${expected}"` : "nothing"}`,
      );
    }
  });
}

/** The failure a compensation is cleaning up after, recovered from the log. */
function failureFrom(
  definition: SagaDefinition<SagaState>,
  record: SagaInstanceRecord,
): SagaFailure {
  for (let index = record.log.length - 1; index >= 0; index -= 1) {
    const item = record.log[index];
    if (item && item.direction === "forward" && item.outcome === "failed") {
      return { step: item.step, message: item.error ?? record.lastError ?? "unknown failure" };
    }
  }
  // Not reachable from a saga this orchestrator turned around — it always logs
  // the failure that did it — but a compensation must be given *something*
  // rather than `undefined` with a comment saying it cannot happen.
  return {
    step: definition.steps[record.cursor]?.name ?? "unknown",
    message: record.lastError ?? "unknown failure",
  };
}

/**
 * Folds a step's patch into the state.
 *
 * `undefined` is dropped rather than written, because `undefined` is not JSON:
 * a `jsonb` round trip cannot tell a key set to nothing from a key that was
 * never written, so honouring it would mean a state that changes shape when it
 * is reloaded. A step that means "clear this" writes `null`, which survives —
 * the same reason `SagaState` fields are nullable rather than optional.
 */
function mergeState(state: SagaState, patch: Partial<SagaState> | void): SagaState {
  if (!patch) return state;
  const merged: { [key: string]: JsonValue } = { ...state };
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined) merged[key] = value;
  }
  return merged;
}

function entry(
  step: string,
  direction: SagaDirection,
  outcome: SagaStepLogEntry["outcome"],
  attempt: number,
  at: Date,
  error?: Error,
): SagaStepLogEntry {
  return {
    step,
    direction,
    outcome,
    attempt,
    at: at.toISOString(),
    ...(error ? { error: truncate(error.message) } : {}),
  };
}

function asError(caught: unknown): Error {
  return caught instanceof Error ? caught : new Error(String(caught));
}

/** The log and `lastError` are diagnostics, not logs. Same limit as the outbox's. */
function truncate(message: string, limit = 500): string {
  return message.length <= limit ? message : `${message.slice(0, limit - 1)}…`;
}
