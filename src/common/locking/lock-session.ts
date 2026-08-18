import { AsyncLocalStorage } from "node:async_hooks";
import { LockLostError, LockNotAcquiredError } from "./locking.errors";
import { SystemLockClock } from "./ports";
import type {
  DistributedLock,
  LockAcquireOptions,
  LockClock,
  LockHandle,
  LockLogger,
} from "./ports";

/**
 * The lock the currently running code holds, if any.
 *
 * Carried in an `AsyncLocalStorage` rather than passed as an argument so that
 * `@Lock()` does not have to change the signature of the method it decorates —
 * a decorator that forced every guarded method to take an extra parameter would
 * be a decorator nobody applies to existing code.
 *
 * Read it wherever the fenced write happens, however deep:
 *
 * ```ts
 * const lock = currentLock();
 * await orders.update({
 *   where: { id, fencingToken: { lt: lock.fencingToken } },
 *   data: { status: "captured", fencingToken: lock.fencingToken },
 * });
 * ```
 */
export interface CurrentLock {
  readonly key: string;
  readonly fencingToken: number;
  /** The handle itself, for code that needs `remainingMs()` or an early release. */
  readonly handle: LockHandle;
}

const storage = new AsyncLocalStorage<CurrentLock>();

/** The lock held by the caller's async context, or `undefined` outside one. */
export function currentLock(): CurrentLock | undefined {
  return storage.getStore();
}

export interface WithLockOptions extends LockAcquireOptions {
  /**
   * Keep the lease alive while the guarded operation runs. Default `true`.
   *
   * With it, the TTL stops being a bet on how long the work takes and becomes a
   * bet on how quickly a *dead* holder is noticed — which is the bet a TTL is
   * actually good at. Without it, an operation that outruns its TTL silently
   * stops being exclusive; that is still detected (the session refuses to
   * report success), but only after the fact.
   */
  readonly renew?: boolean;
  /** Renewal period. Defaults to a third of the TTL, so two renewals may fail before the lease lapses. */
  readonly renewIntervalMs?: number;
  /**
   * Stop renewing after this long, letting the lease expire under a running
   * operation. Unset — the default — renews for as long as the operation runs.
   *
   * Worth setting where a hung call is more likely than a slow one: renewal is
   * why a wedged holder can keep a key forever, and a bound is the only thing
   * that gets the lock back without an operator.
   */
  readonly maxHoldMs?: number;
  readonly clock?: LockClock;
  readonly logger?: LockLogger;
}

/**
 * Runs `operation` while holding `key`, and refuses to report success unless
 * the lock was held for all of it.
 *
 * This is the whole of what `@Lock()` does; it is exported because the decorator
 * only reaches singleton providers (see `AspectWeaver`), and a controller,
 * a BullMQ processor or a script needs the same behaviour by hand.
 *
 * Failure modes, in the order they are checked:
 *
 * - the lock cannot be taken within `waitMs` → {@link LockNotAcquiredError},
 *   and `operation` never runs;
 * - `operation` throws → that error propagates untouched, and the lock is
 *   released;
 * - the lease lapsed while `operation` ran → {@link LockLostError}, *even
 *   though `operation` succeeded*, because its result may be the product of a
 *   race. See the note on that class.
 */
export async function withLock<T>(
  lock: DistributedLock,
  key: string,
  options: WithLockOptions,
  operation: (held: CurrentLock) => Promise<T>,
): Promise<T> {
  const clock = options.clock ?? new SystemLockClock();
  const waitMs = options.waitMs ?? 0;

  const handle = await lock.acquire(key, {
    ttlMs: options.ttlMs,
    waitMs,
    retryDelayMs: options.retryDelayMs,
  });
  if (!handle) throw new LockNotAcquiredError(key, waitMs);

  const held: CurrentLock = { key, fencingToken: handle.fencingToken, handle };
  const acquiredAt = clock.now();
  const renewal = startRenewal(handle, options, clock);

  let result: T;
  try {
    result = await storage.run(held, () => operation(held));
  } catch (error) {
    await stop(renewal, handle, options.logger, key);
    throw error;
  }

  const renewalFailed = await stop(renewal, handle, options.logger, key);
  // Checked as well as `renewalFailed`, because renewal may be off, or the
  // operation may have finished after the lease lapsed but before the renewal
  // loop woke up to find out.
  const lapsed = handle.remainingMs() <= 0;

  if (renewalFailed || lapsed) {
    throw new LockLostError(key, handle.fencingToken, Math.round(clock.now() - acquiredAt));
  }
  return result;
}

interface Renewal {
  /** Resolves `true` if a renewal was refused before the loop was stopped. */
  readonly finished: Promise<boolean>;
  stop(): void;
}

/**
 * Extends the lease every `renewIntervalMs` until stopped.
 *
 * The loop races its sleep against a stop signal rather than sleeping and
 * checking a flag, so a fast operation does not leave a timer pending for the
 * rest of the interval — which in a test is an open handle, and in production
 * is a lock released later than it could have been.
 */
function startRenewal(handle: LockHandle, options: WithLockOptions, clock: LockClock): Renewal {
  if (options.renew === false) {
    return { finished: Promise.resolve(false), stop: () => {} };
  }

  const interval = options.renewIntervalMs ?? Math.max(1, Math.floor(options.ttlMs / 3));
  const startedAt = clock.now();
  let stopped = false;
  let release: () => void = () => {};
  const stopSignal = new Promise<void>((resolve) => {
    release = resolve;
  });

  const finished = (async (): Promise<boolean> => {
    for (;;) {
      await Promise.race([clock.sleep(interval), stopSignal]);
      if (stopped) return false;
      if (options.maxHoldMs !== undefined && clock.now() - startedAt >= options.maxHoldMs) {
        // Deliberately not a failure: the caller asked for the lease to be
        // allowed to lapse. Whether it actually has by the time the operation
        // finishes is decided by `remainingMs()` in `withLock`.
        return false;
      }
      if (!(await handle.extend(options.ttlMs))) return true;
    }
  })();

  return {
    finished,
    stop: () => {
      stopped = true;
      release();
    },
  };
}

/** Stops renewing, releases the lock, and reports whether a renewal had failed. */
async function stop(
  renewal: Renewal,
  handle: LockHandle,
  logger: LockLogger | undefined,
  key: string,
): Promise<boolean> {
  renewal.stop();
  const renewalFailed = await renewal.finished;

  try {
    const released = await handle.release();
    if (!released) {
      logger?.warn(
        JSON.stringify({
          lock: "session",
          event: "release-missed",
          key,
          fencingToken: handle.fencingToken,
          reason: "the lease had already lapsed or been taken by another holder",
        }),
      );
    }
  } catch (error) {
    // A lock that cannot be released still expires on its own, so this is worth
    // a line in the log and nothing more. Rethrowing would replace the
    // operation's own outcome with a cleanup failure.
    logger?.warn(
      JSON.stringify({
        lock: "session",
        event: "release-failed",
        key,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
  }

  return renewalFailed;
}
