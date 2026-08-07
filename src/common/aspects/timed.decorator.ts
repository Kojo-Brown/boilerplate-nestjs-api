import { TIMED_METADATA, defineAspectMetadata } from "./aspect.metadata";
import type { AnyMethod } from "./aspect.types";
import { resolveTimedOptions } from "./timed.aspect";
import type { TimedOptions } from "./timed.aspect";

/**
 * Reports how long a method took to the {@link MethodTimingRecorder}, on both
 * the success and the failure path.
 *
 * ```ts
 * @Timed({ name: "users.list", slowerThanMs: 250 })
 * async list(query: ListUsersQuery): Promise<Page<User>> { ... }
 * ```
 *
 * Accepts synchronous methods as well as async ones, and never changes what a
 * method returns.
 */
export function Timed(options: TimedOptions = {}) {
  const resolved = resolveTimedOptions(options);

  return <T extends AnyMethod>(
    target: object,
    propertyKey: string | symbol,
    _descriptor: TypedPropertyDescriptor<T>,
  ): void => {
    defineAspectMetadata(TIMED_METADATA, resolved, target, propertyKey);
  };
}
