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

/**
 * A distributed lock could not be taken within the caller's wait budget.
 *
 * Covers both "someone else holds it" and "not enough Redis nodes answered",
 * deliberately — see {@link DistributedLock.acquire}. Neither is a reason for
 * this caller to proceed, and code that branches on the difference eventually
 * branches wrongly.
 *
 * A plain `Error` rather than an `HttpException`, for the same reason
 * {@link LockUnavailableError} is: contention reached over a queue consumer or
 * a CLI is not a "409". `docs/distributed-locking.md` shows the mapping to use
 * at an HTTP call site.
 */
export class LockNotAcquiredError extends Error {
  constructor(
    readonly key: string,
    readonly waitedMs: number,
    options?: { cause?: unknown },
  ) {
    super(`Could not acquire the distributed lock "${key}" within ${waitedMs}ms`);
    this.name = "LockNotAcquiredError";
    if (options?.cause !== undefined) this.cause = options.cause;
  }
}

/**
 * The lease lapsed while the guarded method was still running.
 *
 * Raised even when that method resolved successfully, which is the point: the
 * result was computed by a caller that had stopped being the holder, so
 * somebody else may have been running the same operation at the same time.
 * Reporting success would hide exactly the interleaving the lock was there to
 * prevent.
 *
 * It is not a rollback — nothing here can retract what the method already did.
 * The recourse is on the resource: a fenced write quoting
 * {@link LockHandle.fencingToken} would have been refused, and an operation
 * that cannot be fenced has to be idempotent instead.
 */
export class LockLostError extends Error {
  constructor(
    readonly key: string,
    readonly fencingToken: number,
    readonly heldMs: number,
  ) {
    super(
      `Lost the distributed lock "${key}" (fencing token ${fencingToken}) after ${heldMs}ms, ` +
        "while the guarded operation was still running",
    );
    this.name = "LockLostError";
  }
}
