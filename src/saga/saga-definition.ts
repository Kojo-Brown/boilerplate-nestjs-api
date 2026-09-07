import { SagaDefinitionError } from "./saga.errors";
import type { SagaState, SagaStatePatch } from "./saga-state";

/**
 * Where a step sits relative to the point of no return.
 *
 * The three kinds are Garcia-Molina and Salem's structure as Chris Richardson
 * states it, and they are not decoration: the orchestrator reads the kind to
 * decide whether a failure may be rolled back or must be driven forward.
 *
 * - `compensatable` — undoable, so a later failure can unwind it. Must declare
 *   its compensation, and the type below refuses it if it does not.
 * - `pivot` — the go/no-go point. If it fails the saga compensates; once it
 *   succeeds the saga is committed and nothing after it may be rolled back.
 *   At most one, and everything before it must be compensatable.
 * - `retriable` — after the pivot. Guaranteed to succeed *eventually*, because
 *   there is no longer any other option: the money is taken and the parcel is
 *   with the carrier. A retriable step that runs out of attempts leaves the
 *   saga `STUCK` for a human rather than silently backing out of something it
 *   cannot back out of.
 */
export type SagaStepKind = "compensatable" | "pivot" | "retriable";

/** What a step is handed when the orchestrator runs it. */
export interface SagaStepContext<S extends SagaState> {
  /** The instance id. Stable for the life of the saga. */
  readonly sagaId: string;
  /** Everything previous steps have contributed. */
  readonly state: S;
  /**
   * A key this step may hand to whatever it calls, so a retry is not a second
   * side effect.
   *
   * `<sagaId>:<step name>`, and both halves matter: it is stable across every
   * attempt of one step — which is what makes it an idempotency key rather than
   * a request id — and distinct between steps, so a saga that charges and then
   * refunds is not two calls under one key.
   *
   * At-least-once execution is not a caveat to be read past. The orchestrator
   * writes the step's outcome *after* the step returns, in a separate
   * transaction from whatever the step itself did, because the step's work is a
   * call to another service and there is no transaction that spans both. A
   * crash in that window re-runs the step on recovery. Participants must
   * therefore be idempotent on this key, and every step in this repository is.
   */
  readonly idempotencyKey: string;
  /** The request that started the saga, when the caller knew it. */
  readonly correlationId: string | null;
  /**
   * Why the saga is going backwards. Present only in `compensate`.
   *
   * A compensation usually wants it: cancelling an order writes the reason the
   * customer will read, and a compensation that had to invent one would either
   * say nothing useful or duplicate the orchestrator's own error handling.
   */
  readonly failure?: SagaFailure;
}

/** The failure that turned the saga around. */
export interface SagaFailure {
  /** The step that could not be completed. */
  readonly step: string;
  readonly message: string;
}

interface SagaStepBase<S extends SagaState> {
  /**
   * Stable, kebab-case, and part of the idempotency key — so renaming a step is
   * a data migration, not a rename. The orchestrator resolves a persisted
   * cursor against the definition by *position*, and `assertResumable` checks
   * the name at that position still matches what the row last ran.
   */
  readonly name: string;

  /**
   * Does the step's work and returns what it learned.
   *
   * Throw to fail. A plain error is transient — the orchestrator retries it on
   * a full-jitter ladder — and {@link import("./saga.errors").UnretryableStepError}
   * is permanent, which turns the saga around immediately instead of spending
   * eight attempts proving that a card will still be declined. That split is
   * the same one `DomainEventConsumer` makes between a handler failure and an
   * undecodable message, for the same reason: a condition that cannot pass is
   * not worth waiting on.
   */
  execute(context: SagaStepContext<S>): Promise<SagaStatePatch<S> | void>;
}

/**
 * One step of a saga.
 *
 * A discriminated union rather than an interface with an optional
 * `compensate`, and it buys two guarantees the optional form cannot. A
 * `compensatable` step without a compensation does not compile — which would
 * otherwise be a step the orchestrator believes it can unwind and silently
 * skips. And a `pivot` or `retriable` step *with* one does not compile either:
 * the orchestrator will never call it, so its presence is a claim about the
 * system that is not true.
 */
export type SagaStep<S extends SagaState> =
  | (SagaStepBase<S> & {
      readonly kind: "compensatable";
      /**
       * Undoes {@link SagaStepBase.execute}, as far as anything can be undone.
       *
       * Two properties, both non-negotiable, both because of at-least-once:
       *
       * - **Idempotent.** It may run twice. Refunding twice is worse than the
       *   failure it is cleaning up after.
       * - **Tolerant of nothing to undo.** It runs for the step that *failed*
       *   as well as for the steps that completed, because a step that threw
       *   may still have half-executed — an authorisation taken and the
       *   response lost. A compensation that assumed its step had completed
       *   would throw on the one case it exists for.
       *
       * Throwing is retried on the same ladder as a forward step. A
       * compensation that exhausts its attempts leaves the saga `STUCK`, which
       * is the only honest disposition: the alternative is a system that has
       * taken money it has decided not to keep and has stopped trying to
       * return it.
       */
      compensate(context: SagaStepContext<S>): Promise<void>;
    })
  | (SagaStepBase<S> & { readonly kind: "pivot" })
  | (SagaStepBase<S> & { readonly kind: "retriable" });

/** An ordered list of steps with a name, and the invariants below hold of it. */
export interface SagaDefinition<S extends SagaState> {
  /** Persisted on every instance, so the recovery poller can find the definition again. */
  readonly name: string;
  readonly steps: readonly SagaStep<S>[];
}

/**
 * Builds a definition and refuses an incoherent one at construction.
 *
 * Every check here is a bug that would otherwise appear as a saga behaving
 * strangely in production rather than as an error at boot, and each is cheap
 * to state and impossible to catch by testing the happy path:
 *
 * - **No steps.** A saga that does nothing completes instantly and hides
 *   whatever wiring mistake produced it.
 * - **Duplicate names.** Names are idempotency keys and log entries; two steps
 *   sharing one means two calls under a single key, which is the one thing an
 *   idempotency key exists to prevent.
 * - **Ordering.** The shape must be `compensatable* pivot? retriable*`. A
 *   compensatable step after the pivot is a promise to unwind something past
 *   the point of no return; a retriable step before it is a step the
 *   orchestrator would refuse to roll back while the saga can still legally go
 *   backwards. Both are silent in a happy-path test and wrong the first time
 *   something fails.
 */
export function defineSaga<S extends SagaState>(
  name: string,
  steps: readonly SagaStep<S>[],
): SagaDefinition<S> {
  if (steps.length === 0) {
    throw new SagaDefinitionError(name, "has no steps");
  }

  const seen = new Set<string>();
  for (const step of steps) {
    if (seen.has(step.name)) {
      throw new SagaDefinitionError(name, `declares the step "${step.name}" twice`);
    }
    seen.add(step.name);
  }

  const pivotIndex = steps.findIndex((step) => step.kind === "pivot");
  if (steps.filter((step) => step.kind === "pivot").length > 1) {
    throw new SagaDefinitionError(name, "declares more than one pivot step");
  }

  // With no pivot every step is compensatable and the saga can always be rolled
  // back in full, which is a legitimate shape — so the boundary is the end.
  const boundary = pivotIndex === -1 ? steps.length : pivotIndex;
  steps.forEach((step, index) => {
    if (index < boundary && step.kind !== "compensatable") {
      throw new SagaDefinitionError(
        name,
        `step "${step.name}" is "${step.kind}" but runs before the pivot, where every ` +
          "step must be compensatable",
      );
    }
    if (index > boundary && step.kind !== "retriable") {
      throw new SagaDefinitionError(
        name,
        `step "${step.name}" is "${step.kind}" but runs after the pivot, where nothing ` +
          "may be rolled back and every step must be retriable",
      );
    }
  });

  return { name, steps };
}
