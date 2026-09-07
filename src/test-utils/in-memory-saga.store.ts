import type { TransactionContext } from "@/common/prisma/transaction.port";
import type {
  NewSagaInstance,
  SagaClaim,
  SagaInstanceRecord,
  SagaProgress,
  SagaStatus,
  SagaStore,
} from "@/saga";

/**
 * In-memory implementation of {@link SagaStore}.
 *
 * It exists so the unit and e2e suites can run whole sagas — steps,
 * compensations, retries, recovery — with no Postgres, the same reason
 * `InMemoryOutboxStore` exists. `saga-store.contract.spec.ts` holds it to the
 * same behavioural contract as the Prisma adapter, which is where a double that
 * quietly handed one instance to two runners would be caught.
 *
 * What it cannot stand in for is the atomicity of the claim. Here `claim` is
 * atomic because the event loop says so: nothing interleaves between the check
 * and the write, since neither awaits. Against Postgres that property is the
 * single `UPDATE … WHERE … RETURNING`, and a store that read and then wrote
 * would pass every test in this file and hand the same saga to two replicas in
 * production. `test/saga-store.db-spec.ts` is the half that asks the database.
 */
export class InMemorySagaStore implements SagaStore {
  private readonly rows = new Map<string, SagaInstanceRecord>();

  create(tx: TransactionContext, instance: NewSagaInstance): Promise<SagaInstanceRecord> {
    const now = new Date();
    const record: SagaInstanceRecord = {
      id: instance.id,
      name: instance.name,
      status: "RUNNING",
      cursor: 0,
      attempts: 0,
      nextAttemptAt: now,
      state: instance.state,
      log: [],
      lastError: null,
      correlationId: instance.correlationId,
      lockedBy: null,
      lockedUntil: null,
      createdAt: now,
      updatedAt: now,
    };
    this.rows.set(record.id, record);
    // The one part of the contract a double can honour: a saga staged inside a
    // unit of work that then fails must not exist. Without this, an order whose
    // creation rolled back would leave an instance the recovery poller happily
    // advances against a row that is not there.
    tx.onRollback(() => {
      this.rows.delete(record.id);
    });
    return Promise.resolve(record);
  }

  find(id: string): Promise<SagaInstanceRecord | null> {
    return Promise.resolve(this.rows.get(id) ?? null);
  }

  claim(id: string, claim: SagaClaim): Promise<SagaInstanceRecord | null> {
    const row = this.rows.get(id);
    if (!row || !isClaimable(row, claim.now)) return Promise.resolve(null);
    return Promise.resolve(this.lease(row, claim));
  }

  claimDue(claim: SagaClaim, limit: number): Promise<readonly SagaInstanceRecord[]> {
    const due = [...this.rows.values()]
      .filter((row) => isClaimable(row, claim.now))
      .sort(
        (a, b) => a.nextAttemptAt.getTime() - b.nextAttemptAt.getTime() || (a.id < b.id ? -1 : 1),
      )
      .slice(0, limit);
    return Promise.resolve(due.map((row) => this.lease(row, claim)));
  }

  save(id: string, claim: SagaClaim, progress: SagaProgress): Promise<SagaInstanceRecord | null> {
    const row = this.rows.get(id);
    // The fencing check, and the reason `save` can return null at all: a runner
    // whose lease expired mid-step has been replaced, and its write is about a
    // step its replacement has already re-run.
    if (!row || row.lockedBy !== claim.owner) return Promise.resolve(null);

    const updated: SagaInstanceRecord = {
      ...row,
      status: progress.status,
      cursor: progress.cursor,
      attempts: progress.attempts,
      nextAttemptAt: progress.nextAttemptAt,
      state: progress.state,
      log: [...row.log, progress.entry],
      lastError: progress.lastError,
      lockedBy: progress.release ? null : claim.owner,
      lockedUntil: progress.release ? null : new Date(claim.now.getTime() + claim.leaseMs),
      updatedAt: claim.now,
    };
    this.rows.set(id, updated);
    return Promise.resolve(updated);
  }

  abandon(id: string, status: Extract<SagaStatus, "STUCK">, reason: string): Promise<void> {
    const row = this.rows.get(id);
    if (row) {
      this.rows.set(id, {
        ...row,
        status,
        lastError: reason,
        lockedBy: null,
        lockedUntil: null,
        updatedAt: new Date(),
      });
    }
    return Promise.resolve();
  }

  countByStatus(): Promise<Record<SagaStatus, number>> {
    const counts: Record<SagaStatus, number> = {
      RUNNING: 0,
      COMPENSATING: 0,
      COMPLETED: 0,
      COMPENSATED: 0,
      STUCK: 0,
    };
    for (const row of this.rows.values()) counts[row.status] += 1;
    return Promise.resolve(counts);
  }

  /** Forgets every instance, for a suite that shares one application. */
  reset(): void {
    this.rows.clear();
  }

  /** Every instance, for a spec that wants to assert on the whole table. */
  all(): readonly SagaInstanceRecord[] {
    return [...this.rows.values()];
  }

  /**
   * Expires a lease without touching anything else.
   *
   * Stands in for the one thing a test cannot otherwise produce: a runner that
   * stalled past its lease while another took over. Used by the fencing specs.
   */
  expireLease(id: string): void {
    const row = this.rows.get(id);
    if (row) this.rows.set(id, { ...row, lockedBy: null, lockedUntil: null });
  }

  /**
   * Overwrites an instance wholesale.
   *
   * The only way a spec can produce the state a *crash* produces: a runner that
   * called every participant and died before writing that it had, so the row
   * still says it is at a step whose side effects have already happened. There
   * is no legitimate caller for this outside a test, which is why it is on the
   * double rather than on the port.
   */
  replace(record: SagaInstanceRecord): void {
    this.rows.set(record.id, record);
  }

  private lease(row: SagaInstanceRecord, claim: SagaClaim): SagaInstanceRecord {
    const leased: SagaInstanceRecord = {
      ...row,
      lockedBy: claim.owner,
      lockedUntil: new Date(claim.now.getTime() + claim.leaseMs),
      updatedAt: claim.now,
    };
    this.rows.set(row.id, leased);
    return leased;
  }
}

function isClaimable(row: SagaInstanceRecord, now: Date): boolean {
  if (row.status !== "RUNNING" && row.status !== "COMPENSATING") return false;
  if (row.nextAttemptAt.getTime() > now.getTime()) return false;
  return row.lockedUntil === null || row.lockedUntil.getTime() <= now.getTime();
}
