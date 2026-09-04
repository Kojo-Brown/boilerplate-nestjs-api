/**
 * The unit-of-work seam.
 *
 * A transactional outbox is only transactional if the event and the data it
 * describes commit together, which means some caller has to own a transaction
 * that both writes join. That caller is an application service — `AuthService`,
 * `DeleteUserHandler` — and those callers depend on ports, not on Prisma (DIP).
 * This is the port that lets them open a transaction without learning what a
 * transaction is made of.
 *
 * The handle is deliberately opaque. A service passes it from the runner to
 * whichever adapters are taking part and never looks inside; each adapter
 * narrows it back to the concrete handle it understands and refuses one it does
 * not, so passing a handle from the wrong backend is a clear error at the first
 * write rather than a `TypeError` three frames down.
 */
export const TRANSACTION_RUNNER = Symbol("TRANSACTION_RUNNER");

/**
 * An in-flight unit of work.
 *
 * `backend` names the runner that produced it. It exists so that an adapter can
 * say "this is not my transaction" in a message an operator can act on, and so
 * that a future second backing store is a discriminated union rather than a
 * cast.
 */
export interface TransactionContext {
  readonly backend: string;

  /**
   * Registers a compensation to run if the unit of work fails.
   *
   * The database rolls itself back and needs none of this. It exists for the
   * participants that are *not* the database — an in-memory double standing in
   * for a store in a test, an in-process buffer — which would otherwise keep
   * writes the transaction abandoned and quietly diverge from the adapter they
   * are standing in for.
   *
   * Compensations run in reverse registration order, before the failure is
   * re-thrown. A compensation that itself throws must not mask the original
   * error, so the runner logs it and carries on with the rest.
   *
   * This is not a substitute for a transaction: a compensation runs only when
   * the callback throws, so it cannot help with a commit that fails after the
   * callback returned. Anything that needs real atomicity belongs in the
   * database.
   */
  onRollback(undo: () => void | Promise<void>): void;
}

export interface TransactionRunner {
  /**
   * Runs `work` as one atomic unit, resolving with whatever it returns.
   *
   * The transaction commits when `work` resolves and rolls back when it
   * rejects. Everything `work` awaits happens inside the transaction, so it
   * must not contain anything slow or remote: an HTTP call in here holds a
   * database connection and every row it has touched for the duration.
   */
  run<T>(work: (tx: TransactionContext) => Promise<T>): Promise<T>;
}
