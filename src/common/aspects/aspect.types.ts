/**
 * A method the aspects may wrap.
 *
 * `never[]` rather than `unknown[]` is the standard trick for "any function":
 * under `strictFunctionTypes` a parameter list of `unknown[]` would reject
 * `(id: string) => Promise<User>`, because `unknown` is not assignable to
 * `string`. `never` is assignable to everything, so the constraint admits every
 * signature while still pinning the return type — which is the half that
 * matters here.
 */
export type AnyMethod = (...args: never[]) => unknown;

/**
 * `@Cacheable()` and `@Retry()` are declared against this so that applying them
 * to a synchronous method is a compile error rather than a surprise at runtime.
 * Both aspects have to `await` the result — a cache cannot be read
 * synchronously and a retry has to wait between attempts — so a synchronous
 * method would silently start returning a promise to callers that expect a
 * value. `@Timed()` has no such constraint and accepts either.
 */
export type AsyncMethod = (...args: never[]) => Promise<unknown>;

/**
 * The two log levels the aspects use, so a test can capture them without
 * building a Nest `Logger` (which satisfies this interface as-is).
 */
export interface AspectLogger {
  debug(message: string): void;
  warn(message: string): void;
}

/** Which method is being invoked, for cache keys, metrics names and log lines. */
export interface AspectContext {
  /** The class name, e.g. `UsersService`. */
  readonly target: string;
  readonly method: string;
}

/**
 * One link in the aspect chain: takes the original argument list, returns
 * whatever the wrapped method returns.
 *
 * The arguments travel as an array rather than as a spread so that each aspect
 * can pass them through untouched without knowing the arity of what it wraps.
 */
export type AspectInvocation = (args: readonly unknown[]) => unknown;

/**
 * Thrown when a decorator is applied to something it cannot wrap — currently
 * only reachable from JavaScript callers or through a cast, since the
 * `AsyncMethod` constraint catches it at compile time otherwise.
 */
export class AspectUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AspectUsageError";
  }
}

/** Thrown at decoration time (so, at import time) for invalid aspect options. */
export class AspectConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AspectConfigurationError";
  }
}

export function describeContext(context: AspectContext): string {
  return `${context.target}.${context.method}()`;
}

export function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as PromiseLike<unknown>).then === "function"
  );
}

/**
 * Guards the boundary the type system cannot: a method that was cast, or called
 * from JavaScript, and does not actually return a promise. Failing loudly here
 * beats handing the caller a promise it will never await.
 */
export function assertPromiseLike(
  value: unknown,
  context: AspectContext,
  aspect: string,
): asserts value is PromiseLike<unknown> {
  if (!isPromiseLike(value)) {
    throw new AspectUsageError(
      `@${aspect}() requires ${describeContext(context)} to return a promise, got ${typeof value}.`,
    );
  }
}
