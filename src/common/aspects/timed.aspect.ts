import { AspectConfigurationError, describeContext, isPromiseLike } from "./aspect.types";
import type { AspectContext, AspectInvocation, AspectLogger } from "./aspect.types";
import type { AspectClock, MethodTiming, MethodTimingRecorder } from "./ports";

export interface TimedOptions {
  /** Metric name. Defaults to `Class.method`. */
  name?: string;
  /** Calls at or above this duration are flagged `slow` on the sample. */
  slowerThanMs?: number;
}

export type ResolvedTimedOptions = TimedOptions;

export function resolveTimedOptions(options: TimedOptions = {}): ResolvedTimedOptions {
  if (options.name !== undefined && options.name.length === 0) {
    throw new AspectConfigurationError("@Timed({ name }) must not be empty.");
  }
  if (
    options.slowerThanMs !== undefined &&
    (!Number.isFinite(options.slowerThanMs) || options.slowerThanMs < 0)
  ) {
    throw new AspectConfigurationError(
      `@Timed({ slowerThanMs }) must be a non-negative number, got ${options.slowerThanMs}.`,
    );
  }
  return options;
}

export interface TimedDependencies {
  readonly clock: AspectClock;
  readonly recorder: MethodTimingRecorder;
  readonly logger: AspectLogger;
}

/**
 * Unlike the other two aspects this one supports synchronous methods, and has
 * to: it is the aspect you reach for to find out whether a method is worth
 * making asynchronous in the first place. A synchronous call is measured and
 * its value returned as-is, never wrapped in a promise.
 */
export function applyTiming(
  next: AspectInvocation,
  context: AspectContext,
  options: ResolvedTimedOptions,
  deps: TimedDependencies,
): AspectInvocation {
  const name = options.name ?? `${context.target}.${context.method}`;

  const record = (startedAt: number, error: unknown, failed: boolean): void => {
    const durationMs = deps.clock.now() - startedAt;
    const timing: MethodTiming = {
      name,
      target: context.target,
      method: context.method,
      durationMs,
      outcome: failed ? "failure" : "success",
      slow: options.slowerThanMs !== undefined && durationMs >= options.slowerThanMs,
      ...(failed ? { error: describeError(error) } : {}),
    };

    try {
      deps.recorder.record(timing);
    } catch (recorderError) {
      // Observability is never worth failing a call over: a metrics backend
      // that is down would otherwise take every timed method down with it.
      deps.logger.warn(
        JSON.stringify({
          aspect: "timed",
          method: describeContext(context),
          event: "recorder-failed",
          error: recorderError instanceof Error ? recorderError.message : String(recorderError),
        }),
      );
    }
  };

  return (args) => {
    const startedAt = deps.clock.now();

    let result: unknown;
    try {
      result = next(args);
    } catch (error) {
      record(startedAt, error, true);
      throw error;
    }

    if (!isPromiseLike(result)) {
      record(startedAt, undefined, false);
      return result;
    }

    return Promise.resolve(result).then(
      (value) => {
        record(startedAt, undefined, false);
        return value;
      },
      (error: unknown) => {
        record(startedAt, error, true);
        throw error;
      },
    );
  };
}

function describeError(error: unknown): { name: string; message: string } {
  if (error instanceof Error) return { name: error.name, message: error.message };
  return { name: typeof error, message: String(error) };
}
