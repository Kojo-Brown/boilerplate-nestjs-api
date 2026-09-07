import type { TransactionContext } from "@/common/prisma/transaction.port";
import type {
  NewSagaInstance,
  SagaInstanceRecord,
  SagaProgress,
  SagaStatus,
} from "../saga-instance";

/** DI token for {@link SagaStore}. */
export const SAGA_STORE = Symbol("SAGA_STORE");

/** What a runner needs to take, hold and extend a lease. */
export interface SagaClaim {
  /**
   * Who is claiming. A value unique to one advance — not to the process — so
   * that a runner which loses its lease and takes a fresh one cannot be
   * mistaken for its earlier self by a write still in flight.
   */
  readonly owner: string;
  readonly now: Date;
  /** How long the claim is good for. Must exceed the step timeout; see env.schema.ts. */
  readonly leaseMs: number;
}

/**
 * Persistence for saga instances.
 *
 * Three groups of operation, and the shape of each is forced by what a saga is:
 *
 * - {@link create} joins the caller's transaction and opens none, exactly as
 *   `OutboxStore.stage` does. An order that commits without the saga that
 *   drives it is an order nothing will ever advance, and a saga that commits
 *   without its order is a saga about nothing.
 * - {@link claim} and {@link claimDue} take a **lease** rather than holding a
 *   row lock. The outbox holds its transaction open across the broker call and
 *   says why in `docs/outbox.md`; a saga cannot copy that, because a step is an
 *   arbitrary call to another service with no bound the database knows about,
 *   and parking a Postgres connection on somebody else's network is how a slow
 *   dependency becomes a failing API.
 * - {@link save} is conditional on the lease. That is the price of not holding
 *   a lock: a runner that stalled past its lease has been replaced, and its
 *   write must not land on top of its replacement's.
 */
export interface SagaStore {
  /**
   * Writes a new instance inside the caller's transaction.
   *
   * The row is created `RUNNING`, at cursor zero, due immediately — so the
   * request that created it can run the first step without waiting for a poll,
   * and the recovery poller will pick it up if that request never gets the
   * chance.
   */
  create(tx: TransactionContext, instance: NewSagaInstance): Promise<SagaInstanceRecord>;

  /** Reads one instance without claiming it. For queries and for tests. */
  find(id: string): Promise<SagaInstanceRecord | null>;

  /**
   * Takes the lease on one instance, or resolves `null`.
   *
   * `null` covers every reason a runner may not proceed and does not
   * distinguish between them, because the caller's response to all of them is
   * the same: someone else holds the lease, the saga is not due yet, it is
   * already terminal, or it does not exist. A runner that treated any of those
   * as an error would log a failure for the ordinary case of two replicas
   * reaching for the same saga.
   *
   * Atomic. Read-then-update would let two runners both see a free lease.
   */
  claim(id: string, claim: SagaClaim): Promise<SagaInstanceRecord | null>;

  /**
   * Takes the lease on up to `limit` instances that are due.
   *
   * The recovery poller's query. Instances already leased are skipped rather
   * than waited for, so a second replica polls a disjoint set instead of
   * blocking behind the first one's remote calls.
   *
   * When more are due than `limit`, the ones due longest are the ones claimed —
   * so a backlog drains oldest-first rather than starving whatever was unlucky.
   * That is a statement about *which* instances come back and deliberately not
   * about the order they come back in: `UPDATE … WHERE id IN (SELECT … ORDER BY
   * …) RETURNING *` does not promise to return rows in the sub-select's order,
   * and nothing needs it to. Sagas are independent of each other, unlike outbox
   * rows, whose delivery order is part of what the outbox promises.
   */
  claimDue(claim: SagaClaim, limit: number): Promise<readonly SagaInstanceRecord[]>;

  /**
   * Records one advance, if the lease is still held.
   *
   * Resolves with the updated record, or `null` when the lease has moved on —
   * which is not an error either: it means this runner was slow, another one
   * took over, and everything this one was about to write is about a step the
   * new owner has already re-run. The correct response is to stop, quietly.
   *
   * Extends the lease when {@link SagaProgress.release} is false, so a
   * multi-step advance holds one claim throughout rather than racing its own
   * expiry between steps.
   */
  save(id: string, claim: SagaClaim, progress: SagaProgress): Promise<SagaInstanceRecord | null>;

  /**
   * Moves an instance straight to a terminal status, lease or no lease.
   *
   * The escape hatch for a saga that cannot be advanced at all — a definition
   * this build no longer has, or a cursor that no longer names the step it was
   * written against. Without it such a row is claimed, refused and released
   * every poll, forever, which is a busy loop that also hides every other saga
   * behind it in the log.
   */
  abandon(id: string, status: Extract<SagaStatus, "STUCK">, reason: string): Promise<void>;

  /**
   * How many instances are in each status.
   *
   * `STUCK` is the number worth alerting on: every one of them is money or
   * stock in a state the system decided against and could not undo. It scans,
   * so it belongs on a health endpoint or a metrics tick, never on a request.
   */
  countByStatus(): Promise<Record<SagaStatus, number>>;
}
