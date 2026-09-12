/**
 * What application code may take from `@/telemetry`.
 *
 * `otel-sdk.ts` and `register.ts` are deliberately **absent**. Everything
 * exported here is a thin wrapper over `@opentelemetry/api`, which is a few
 * kilobytes of no-ops until a provider is installed; `otel-sdk.ts` pulls in the
 * SDK, three exporters and three instrumentations, and re-exporting it through
 * the barrel would mean the outbox importing a header helper also loads the
 * OTLP transport. `main.ts` imports the bootstrap from its own path, which is
 * the only place that should.
 */
export { OTEL_EXPORTERS, refineTelemetryEnv, telemetryEnvShape } from "./telemetry.env";
export type { OtelExporterName, TelemetryEnv } from "./telemetry.env";

export {
  EMPTY_TRACE_CARRIER,
  TRACEPARENT_HEADER,
  TRACESTATE_HEADER,
  activeTraceFields,
  contextFromTraceCarrier,
  currentTraceCarrier,
  extractTraceContext,
  headerCarrierGetter,
  injectTraceContext,
} from "./trace-context";
export type { TraceCarrier } from "./trace-context";

export { INSTRUMENTATION_SCOPE, meterFor, recordSpanError, tracerFor } from "./spans";

export { TelemetryLogger } from "./telemetry-logger";
