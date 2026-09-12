import {
  SpanStatusCode,
  metrics,
  trace,
  type Meter,
  type Span,
  type Tracer,
} from "@opentelemetry/api";

/**
 * The instrumentation-scope prefix for everything this service records by hand.
 *
 * A scope is how a backend tells *our* spans and metrics apart from a library's
 * — `@opentelemetry/instrumentation-http` publishes under its own package name
 * — so a single flat name for the whole service would make the outbox's
 * instruments indistinguishable from the consumer's the day one of them starts
 * misbehaving.
 */
export const INSTRUMENTATION_SCOPE = "boilerplate-nestjs-api";

/** The tracer one component records under, e.g. `tracerFor("outbox")`. */
export function tracerFor(component: string): Tracer {
  return trace.getTracer(`${INSTRUMENTATION_SCOPE}/${component}`);
}

/** The meter one component records under. Same naming rule as {@link tracerFor}. */
export function meterFor(component: string): Meter {
  return metrics.getMeter(`${INSTRUMENTATION_SCOPE}/${component}`);
}

/**
 * Marks a span as failed and attaches the exception to it.
 *
 * Both halves matter and they are not the same thing. `recordException` adds an
 * event carrying the type, message and stack, which is what an engineer reads;
 * `setStatus(ERROR)` is what a backend counts, colours red and alerts on. A
 * span with the exception and no status shows up as a successful operation that
 * happens to have an odd event attached to it.
 */
export function recordSpanError(span: Span, error: unknown): void {
  const thrown = error instanceof Error ? error : new Error(String(error));
  span.recordException(thrown);
  span.setStatus({ code: SpanStatusCode.ERROR, message: thrown.message });
}
