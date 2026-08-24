import type { TransactionContext } from "@/common/prisma/transaction.port";
import type { DrainReport, NewOutboxEvent, OutboxRecord, OutboxStatus } from "../outbox-record";

/** DI token for {@link OutboxStore}. */
export const OUTBOX_STORE = Symbol("OUTBOX_STORE");

/**
 * How the relay is told what to do with each claimed row.
 *
 * `deliver` is the broker call. `retryAt` is the retry policy: it returns when
 * the row may next be attempted, or `null` to dead-letter it. Policy lives in
 * the relay and mechanics live in the store, so a store cannot quietly disagree
 * about a backoff and the policy can be tested without a database.
 */
export interface DrainOptions {
  /** Most rows to claim in one pass. A claim holds row locks — keep it small. */
  readonly batchSize: number;
  /** The clock reading the whole pass is evaluated against. */
  readonly now: Date;
  readonly deliver: (record: OutboxRecord) => Promise<void>;
  readonly retryAt: (record: OutboxRecord, error: Error) => Date | null;
}

/**
 * Persistence for the outbox.
 *
 * Two operations, and the asymmetry between them is the whole pattern:
 * {@link stage} joins somebody else's transaction and never opens one, while
 * {@link drain} owns its transaction completely and joins nobody's.
 */
export interface OutboxStore {
  /**
   * Writes an event inside the caller's transaction.
   *
   * Takes a {@link TransactionContext} rather than opening its own, and that is
   * the point: an outbox row committed separately from the data it describes is
   * not an outbox, it is a second thing that can fail on its own. Every write
   * on this method's path has to be part of the caller's unit of work.
   */
  stage(tx: TransactionContext, event: NewOutboxEvent): Promise<void>;

  /**
   * Claims up to `batchSize` due rows, delivers each, and records what
   * happened — all inside one transaction.
   *
   * Rows are claimed with `FOR UPDATE SKIP LOCKED`, so a second replica running
   * its own relay takes a disjoint batch instead of blocking or double
   * publishing. The lock is held across `deliver`, which is what makes a relay
   * that dies mid-publish safe: the transaction never commits, the locks are
   * released by the server, and the rows are simply due again. A lease column
   * would avoid holding a transaction open across broker I/O but has to be
   * expired by a clock somebody has to be right about; this trade is written up
   * in `docs/outbox.md`.
   */
  drain(options: DrainOptions): Promise<DrainReport>;

  /**
   * How many rows are in each state. For the health endpoint and for tests —
   * never on a request path, since it scans.
   */
  countByStatus(): Promise<Record<OutboxStatus, number>>;
}
