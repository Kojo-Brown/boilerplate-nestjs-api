import { Injectable, Logger } from "@nestjs/common";

export const METHOD_TIMING_RECORDER = Symbol("METHOD_TIMING_RECORDER");

export interface MethodTiming {
  /** `@Timed({ name })` if given, otherwise `Class.method`. */
  readonly name: string;
  readonly target: string;
  readonly method: string;
  readonly durationMs: number;
  readonly outcome: "success" | "failure";
  /** True when `@Timed({ slowerThanMs })` was set and the call exceeded it. */
  readonly slow: boolean;
  readonly error?: { readonly name: string; readonly message: string };
}

/**
 * Where `@Timed()` samples go.
 *
 * Deliberately not a metrics client: this repo ships no Prometheus or OTel
 * dependency, and picking one for everybody would be the wrong call to make in
 * a boilerplate. Binding this token to an exporter is a one-provider change —
 * see `docs/aspects.md`.
 */
export interface MethodTimingRecorder {
  record(timing: MethodTiming): void;
}

/**
 * Default recorder: one JSON line per timed call, in the same shape the request
 * logger emits, so both land in a log pipeline as structured records.
 *
 * A failed or slow call logs at `warn` because those are the samples someone is
 * looking for; everything else is `debug` and stays out of production logs
 * unless debug is enabled.
 */
@Injectable()
export class LoggingMethodTimingRecorder implements MethodTimingRecorder {
  private readonly logger = new Logger("Timed");

  record(timing: MethodTiming): void {
    const line = JSON.stringify({
      metric: timing.name,
      target: timing.target,
      method: timing.method,
      durationMs: timing.durationMs,
      outcome: timing.outcome,
      slow: timing.slow,
      error: timing.error ?? null,
    });

    if (timing.outcome === "failure" || timing.slow) {
      this.logger.warn(line);
      return;
    }
    this.logger.debug(line);
  }
}
