import type { JsonValue, SagaState } from "./saga-state";

/** Where an instance is in its life. Mirrors the `SagaStatus` enum in the schema. */
export type SagaStatus = "RUNNING" | "COMPENSATING" | "COMPLETED" | "COMPENSATED" | "STUCK";

/** The statuses nothing will move on its own. */
export const TERMINAL_SAGA_STATUSES = ["COMPLETED", "COMPENSATED", "STUCK"] as const;

export function isTerminal(status: SagaStatus): boolean {
  return (TERMINAL_SAGA_STATUSES as readonly SagaStatus[]).includes(status);
}

/** Which way the saga was going when a step ran. */
export type SagaDirection = "forward" | "backward";

/**
 * One thing that happened to one step.
 *
 * Appended, never rewritten, and stored on the instance rather than in a table
 * of its own — so the outcome and the cursor it moves are written in the same
 * statement and cannot disagree. It is bounded by the definition: at most one
 * entry per step per direction, plus one per failure.
 */
export interface SagaStepLogEntry {
  readonly step: string;
  readonly direction: SagaDirection;
  readonly outcome: "completed" | "failed" | "skipped";
  /** ISO-8601, from the orchestrator's clock. */
  readonly at: string;
  /** Which attempt this was, counting from one. */
  readonly attempt: number;
  /** The failure, for `failed`. Truncated: this is a diagnostic, not a log. */
  readonly error?: string;
}

/** A saga about to be started, as the caller describes it. */
export interface NewSagaInstance {
  readonly id: string;
  readonly name: string;
  readonly state: SagaState;
  readonly correlationId: string | null;
}

/** One persisted instance, as every reader sees it. */
export interface SagaInstanceRecord {
  readonly id: string;
  readonly name: string;
  readonly status: SagaStatus;
  /** The step the saga is at: next to run while forward, to undo while backward. */
  readonly cursor: number;
  /** Failures of the step at `cursor`, in the current direction. */
  readonly attempts: number;
  readonly nextAttemptAt: Date;
  readonly state: SagaState;
  readonly log: readonly SagaStepLogEntry[];
  readonly lastError: string | null;
  readonly correlationId: string | null;
  /** The lease holder, or null when nobody holds it. */
  readonly lockedBy: string | null;
  readonly lockedUntil: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/**
 * One advance's worth of change, written in a single statement.
 *
 * Everything the orchestrator decides about a step lands together: the new
 * cursor, the attempts counter, when to try again, the merged state and the log
 * entry. A store that wrote these separately would be able to leave a saga with
 * a cursor from one decision and a state from another, which on resume means
 * running a step against inputs that belong to a different step.
 */
export interface SagaProgress {
  readonly status: SagaStatus;
  readonly cursor: number;
  readonly attempts: number;
  readonly nextAttemptAt: Date;
  /** The whole state, already merged. The store does not merge. */
  readonly state: SagaState;
  /** Appended to `log`. */
  readonly entry: SagaStepLogEntry;
  readonly lastError: string | null;
  /**
   * Whether to drop the lease as part of this write.
   *
   * True when the saga is terminal or is waiting for a later `nextAttemptAt`:
   * holding a lease over a saga nobody is advancing only delays the runner that
   * eventually will. False while an advance keeps going, where the same write
   * extends the lease instead — see `SagaStore.save`.
   */
  readonly release: boolean;
}

/** Anything JSON-shaped that a store is willing to persist as state. */
export function isJsonObject(value: unknown): value is { readonly [key: string]: JsonValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
