import { LOCK_METADATA, defineAspectMetadata } from "./aspect.metadata";
import type { AsyncMethod } from "./aspect.types";
import { resolveLockOptions } from "./lock.aspect";
import type { LockOptions } from "./lock.aspect";

/**
 * Runs the method under a distributed lock, so that only one caller across the
 * whole deployment executes it for a given key at a time.
 *
 * ```ts
 * @Lock({ key: ([orderId]) => `order:${orderId as string}`, ttlMs: 30_000, waitMs: 5_000 })
 * async capture(orderId: string): Promise<Payment> {
 *   const fence = currentLock()!.fencingToken;
 *   ...
 * }
 * ```
 *
 * Three things are worth knowing before applying it.
 *
 * 1. **A lease is not a guarantee.** A holder stopped for longer than `ttlMs`
 *    — a long GC, a suspended VM — resumes still believing it holds the lock,
 *    by which time somebody else does. The defence is on the resource: quote
 *    `currentLock()!.fencingToken` in the write and have the resource refuse
 *    anything lower. Where that is impossible, the operation must be
 *    idempotent, and this decorator is an optimisation rather than a
 *    correctness argument. See `docs/distributed-locking.md`.
 * 2. **It throws rather than degrading.** Contention throws
 *    `LockNotAcquiredError`, and a lease that lapsed mid-flight throws
 *    `LockLostError` even if the method returned a value. Map both at the call
 *    site — 409 and 503 are the usual choices — rather than letting them reach
 *    `AllExceptionsFilter` as a 500.
 * 3. **Only singleton providers.** Like every aspect here, it is installed by
 *    `AspectWeaver` at `onModuleInit`; a controller handler is already bound to
 *    the router by then. Use `withLock()` directly there — the decorator and
 *    the helper run the same code.
 *
 * Applying it to a synchronous method does not compile: the lock is taken
 * asynchronously, so such a method would start returning a promise to callers
 * that expect a value.
 */
export function Lock(options: LockOptions = {}) {
  const resolved = resolveLockOptions(options);

  return <T extends AsyncMethod>(
    target: object,
    propertyKey: string | symbol,
    _descriptor: TypedPropertyDescriptor<T>,
  ): void => {
    defineAspectMetadata(LOCK_METADATA, resolved, target, propertyKey);
  };
}
