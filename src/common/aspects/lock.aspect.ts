import { withLock } from "@/common/locking";
import type { DistributedLock, LockClock, LockLogger } from "@/common/locking";
import { AspectConfigurationError, assertPromiseLike } from "./aspect.types";
import type { AspectContext, AspectInvocation } from "./aspect.types";
import { stableStringify } from "./cache-key";

export interface LockOptions {
  /**
   * Lifetime of the lease, in milliseconds. Default 10,000.
   *
   * With renewal on (the default) this is not a bet on how long the work takes
   * — the lease is extended for as long as it runs — but on how quickly the
   * lock should come back after the holder *dies*. Shorter recovers faster and
   * renews more often; longer survives a longer stall.
   */
  ttlMs?: number;
  /** How long to wait for a held lock. Default 0: fail immediately. */
  waitMs?: number;
  /** Base delay between attempts while waiting. Jittered. */
  retryDelayMs?: number;
  /** Extend the lease while the method runs. Default true. */
  renew?: boolean;
  /** Renewal period. Defaults to a third of `ttlMs`. */
  renewIntervalMs?: number;
  /** Stop renewing after this long. Unset renews for as long as the method runs. */
  maxHoldMs?: number;
  /** Namespace prepended to the generated key. Ignored when `key` is given. */
  keyPrefix?: string;
  /**
   * Builds the lock key from the raw argument list.
   *
   * Needed whenever the default is too coarse or too fine — and it usually is
   * one of the two. `capture(orderId, { idempotencyKey })` locked on its whole
   * argument list is not locked on the order at all, because the second
   * argument differs between the two calls that must not overlap.
   */
  key?: (args: readonly unknown[]) => string;
}

export type ResolvedLockOptions = LockOptions & { ttlMs: number };

export const DEFAULT_LOCK_TTL_MS = 10_000;

/**
 * Validates and fills in defaults. Called by the decorator, so an impossible
 * policy is an error at import time rather than on the first contended call.
 */
export function resolveLockOptions(options: LockOptions = {}): ResolvedLockOptions {
  const ttlMs = options.ttlMs ?? DEFAULT_LOCK_TTL_MS;
  requirePositiveInteger("ttlMs", ttlMs);
  if (options.waitMs !== undefined) requireNonNegative("waitMs", options.waitMs);
  if (options.retryDelayMs !== undefined) requireNonNegative("retryDelayMs", options.retryDelayMs);
  if (options.renewIntervalMs !== undefined) {
    requirePositiveInteger("renewIntervalMs", options.renewIntervalMs);
    if (options.renewIntervalMs >= ttlMs) {
      // A renewal that fires no sooner than the expiry never renews anything:
      // the lease is already gone by the time `extend` reaches Redis.
      throw new AspectConfigurationError(
        `@Lock({ renewIntervalMs }) (${options.renewIntervalMs}) must be below ttlMs (${ttlMs}); ` +
          "a third of it leaves room for two failed renewals.",
      );
    }
  }
  if (options.maxHoldMs !== undefined) requirePositiveInteger("maxHoldMs", options.maxHoldMs);
  if (options.keyPrefix !== undefined && options.keyPrefix.length === 0) {
    throw new AspectConfigurationError("@Lock({ keyPrefix }) must not be empty.");
  }
  return { ...options, ttlMs };
}

function requirePositiveInteger(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new AspectConfigurationError(
      `@Lock({ ${name} }) must be a positive integer number of milliseconds, got ${String(value)}.`,
    );
  }
}

function requireNonNegative(name: string, value: number): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new AspectConfigurationError(
      `@Lock({ ${name} }) must be a non-negative number of milliseconds, got ${String(value)}.`,
    );
  }
}

/**
 * `lock:UsersService.deleteAccount:["u1"]` — namespaced by class and method so
 * two services taking the same argument do not serialise against each other,
 * and readable enough to recognise in `redis-cli --scan`.
 */
export function buildDefaultLockKey(
  context: AspectContext,
  args: readonly unknown[],
  prefix = "lock",
): string {
  return `${prefix}:${context.target}.${context.method}:${stableStringify(args)}`;
}

export interface LockDependencies {
  readonly lock: DistributedLock;
  readonly clock: LockClock;
  readonly logger: LockLogger;
}

/**
 * Wraps a method so that only one caller across the whole deployment runs it
 * for a given key at a time.
 *
 * Unlike `@Cacheable()`, nothing here degrades to calling through. An argument
 * the key cannot be derived from throws, an unreachable quorum throws, and a
 * lapsed lease throws even when the method succeeded — because a lock that
 * silently does not lock is worse than no lock at all: the caller was written
 * on the assumption that it held one.
 */
export function applyLock(
  next: AspectInvocation,
  context: AspectContext,
  options: ResolvedLockOptions,
  deps: LockDependencies,
): AspectInvocation {
  return async (args) => {
    const key = options.key
      ? options.key(args)
      : buildDefaultLockKey(context, args, options.keyPrefix);

    return await withLock(
      deps.lock,
      key,
      {
        ttlMs: options.ttlMs,
        waitMs: options.waitMs,
        retryDelayMs: options.retryDelayMs,
        renew: options.renew,
        renewIntervalMs: options.renewIntervalMs,
        maxHoldMs: options.maxHoldMs,
        clock: deps.clock,
        logger: deps.logger,
      },
      async () => {
        const result = next(args);
        assertPromiseLike(result, context, "Lock");
        return await result;
      },
    );
  };
}
