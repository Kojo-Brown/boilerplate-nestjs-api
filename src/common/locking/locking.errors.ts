/**
 * A row lock could not be taken.
 *
 * Raised for both of the ways a caller asks not to wait forever: `no-wait`,
 * which fails the instant the row is held, and `waitTimeoutMs`, which fails
 * once the wait exceeds a budget. Postgres reports both as SQLSTATE `55P03`
 * (`lock_not_available`) and differs only in the message text — "could not
 * obtain lock on row" against "canceling statement due to lock timeout" — so
 * they are deliberately not split into two classes. The distinction is about
 * how long the caller waited, and the recourse is identical either way: the
 * row is busy, retry later or give up.
 *
 * A plain `Error` rather than an `HttpException`, for the same reason
 * `VersionConflictError` is: it comes from the storage layer, and the same
 * contention reached over a queue consumer or a CLI is not a "409".
 */
export class LockUnavailableError extends Error {
  constructor(
    readonly table: string,
    readonly keys: readonly string[],
    options?: { cause?: unknown },
  ) {
    super(`Could not acquire a row lock on ${table} for ${keys.length} key(s)`);
    this.name = "LockUnavailableError";
    if (options?.cause !== undefined) this.cause = options.cause;
  }
}

/**
 * Postgres chose this transaction as a deadlock victim and rolled it back.
 *
 * Distinct from {@link LockUnavailableError} because the recourse is different:
 * a deadlock victim has lost nothing but time and can usually just be retried,
 * whereas a busy row is likely to still be busy on an immediate retry. It is
 * also the signal that some pair of call sites is taking locks in different
 * orders — `lockRows` sorts precisely so that two callers of *it* cannot
 * deadlock against each other, so seeing this means a lock was taken somewhere
 * else too.
 */
export class DeadlockDetectedError extends Error {
  constructor(
    readonly table: string,
    options?: { cause?: unknown },
  ) {
    super(`Transaction was rolled back as a deadlock victim while locking ${table}`);
    this.name = "DeadlockDetectedError";
    if (options?.cause !== undefined) this.cause = options.cause;
  }
}
