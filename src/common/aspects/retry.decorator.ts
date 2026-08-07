import { RETRY_METADATA, defineAspectMetadata } from "./aspect.metadata";
import type { AsyncMethod } from "./aspect.types";
import { resolveRetryOptions } from "./retry.aspect";
import type { RetryOptions } from "./retry.aspect";

/**
 * Re-runs a failing method under a backoff schedule.
 *
 * ```ts
 * @Retry({ attempts: 4, delayMs: 200 })
 * async capture(id: string): Promise<Payment> { ... }
 * ```
 *
 * Only failures the policy considers transient are retried — by default that
 * excludes 4xx `HttpException`s other than 408 and 429, because retrying the
 * caller's mistake only delays the error. Options are validated here, so an
 * impossible policy fails at import time rather than on the first outage.
 *
 * The method must be idempotent. Nothing here can tell whether the attempt that
 * appeared to fail actually reached the other side.
 */
export function Retry(options: RetryOptions = {}) {
  const resolved = resolveRetryOptions(options);

  return <T extends AsyncMethod>(
    target: object,
    propertyKey: string | symbol,
    _descriptor: TypedPropertyDescriptor<T>,
  ): void => {
    defineAspectMetadata(RETRY_METADATA, resolved, target, propertyKey);
  };
}
