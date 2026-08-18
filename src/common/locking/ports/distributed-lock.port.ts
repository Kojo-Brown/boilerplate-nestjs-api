/**
 * Which implementation backs `@Lock()` and `withLock()`.
 *
 * Declared here rather than in `config/env.schema.ts` so the module owns its
 * own vocabulary and the config layer imports it — the same arrangement
 * `IDEMPOTENCY_STORE_NAMES` and `STORAGE_ADAPTER_NAMES` use.
 */
export const DISTRIBUTED_LOCK_NAMES = ["redlock", "memory"] as const;

export type DistributedLockName = (typeof DISTRIBUTED_LOCK_NAMES)[number];

/** Injection token for the selected {@link DistributedLock}. */
export const DISTRIBUTED_LOCK = Symbol("DISTRIBUTED_LOCK");

/**
 * The two levels the locking code logs at.
 *
 * Narrower than Nest's `Logger` (which satisfies it as-is) so a test can
 * capture what was logged without standing one up — and so a caller can route
 * lock diagnostics somewhere other than the application log.
 */
export interface LockLogger {
  debug(message: string): void;
  warn(message: string): void;
}

export interface LockAcquireOptions {
  /**
   * How long the lock is held before it expires on its own, in milliseconds.
   *
   * There is no such thing as a lock without one. A holder that crashes, is
   * paused by the OS, or loses its network cannot release anything, so a lease
   * that never expires is a lock that is never released. The TTL is therefore a
   * bet — "this work finishes in under N ms" — and every holder must be written
   * to survive losing that bet, which is what {@link LockHandle.fencingToken}
   * is for.
   */
  readonly ttlMs: number;
  /**
   * How long to keep retrying a held lock before giving up, in milliseconds.
   * `0` (the default) makes a single attempt.
   */
  readonly waitMs?: number;
  /**
   * Base delay between attempts while waiting. Jittered by the implementation,
   * because two callers that collide once will otherwise collide on every
   * retry for as long as both are waiting.
   */
  readonly retryDelayMs?: number;
}

/**
 * A lock this process currently believes it holds.
 *
 * "Believes" is the operative word and the reason every method here is honest
 * about failure: the holder can only ever report what was true at some point in
 * the recent past. {@link remainingMs} is the size of that past.
 */
export interface LockHandle {
  /** The caller's key, without whatever namespacing the implementation applies. */
  readonly key: string;
  /**
   * A number that strictly increases with every successful acquisition.
   *
   * This is the half of distributed locking that a lease alone cannot provide.
   * A holder whose process is stopped for longer than the TTL — a GC pause, a
   * suspended VM, a lost packet — wakes up still believing it holds the lock,
   * by which time someone else does. Nothing on this side can prevent that; the
   * only defence is on the *resource*, which must reject any write carrying a
   * token lower than the highest it has already accepted.
   *
   * Reachable from inside a `@Lock()`-decorated method via `currentLock()`, so
   * the fenced write can quote it without threading it through every signature.
   *
   * A safe integer, and checked to be one — see `docs/distributed-locking.md`
   * for the assumptions monotonicity rests on.
   */
  readonly fencingToken: number;
  /**
   * Reading of the lock clock after which the holder must assume it holds
   * nothing. Already has the clock-drift allowance subtracted, so it is the
   * conservative end of the estimate rather than the nominal expiry.
   */
  readonly validUntil: number;
  /** `validUntil` minus now, floored at zero. */
  remainingMs(): number;
  /**
   * Restarts the lease, and reports whether the lock was still held.
   *
   * `false` means it was not — expired, or taken by someone else — and the
   * caller must stop treating itself as the holder. The fencing token does not
   * change: it identifies this acquisition, not this lease.
   */
  extend(ttlMs: number): Promise<boolean>;
  /**
   * Releases the lock if this handle still holds it, and reports whether it
   * did. Releasing something another holder now owns is exactly the bug the
   * fencing token exists to catch, so it is refused rather than performed.
   */
  release(): Promise<boolean>;
}

/**
 * Mutual exclusion across processes, as `@Lock()` and `withLock()` see one.
 *
 * A port rather than a class because the two implementations differ in what
 * they can honestly claim: `RedlockService` coordinates across replicas and
 * survives losing a minority of its Redis nodes, while
 * `InMemoryDistributedLock` excludes nothing outside its own process and is
 * refused in production for that reason.
 */
export interface DistributedLock {
  /**
   * Takes the lock, or resolves `null` if it could not be taken within
   * `waitMs`.
   *
   * `null` deliberately does not distinguish "someone else holds it" from "not
   * enough nodes answered": both mean this caller must not proceed, and a
   * caller that branches on the difference is a caller that will eventually
   * proceed on the wrong branch. Implementations log the breakdown instead.
   */
  acquire(key: string, options: LockAcquireOptions): Promise<LockHandle | null>;
}
