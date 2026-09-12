import { context, metrics, propagation, trace } from "@opentelemetry/api";
import { logs } from "@opentelemetry/api-logs";
import {
  CompositePropagator,
  W3CBaggagePropagator,
  W3CTraceContextPropagator,
} from "@opentelemetry/core";
import { resourceFromAttributes } from "@opentelemetry/resources";
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
  type ReadableSpan,
} from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import {
  InMemoryMetricExporter,
  AggregationTemporality,
  MeterProvider,
  PeriodicExportingMetricReader,
  type MetricReader,
  type ResourceMetrics,
} from "@opentelemetry/sdk-metrics";
import {
  InMemoryLogRecordExporter,
  LoggerProvider,
  SimpleLogRecordProcessor,
  type ReadableLogRecord,
} from "@opentelemetry/sdk-logs";

/** A live SDK whose output a spec can read back. */
export interface TelemetryProbe {
  /** Spans that have ended, oldest first. */
  spans(): readonly ReadableSpan[];
  /** Log records emitted through the global logger provider. */
  logRecords(): readonly ReadableLogRecord[];
  /** Forces a metric collection and returns what the instruments hold. */
  collectMetrics(): Promise<ResourceMetrics>;
  /** Restores the API globals to their no-op defaults. Call it in `afterEach`. */
  shutdown(): Promise<void>;
}

/**
 * Installs a real SDK with in-memory exporters and hands back a reader for it.
 *
 * Deliberately *not* `startTelemetry()`: that function's job is to wire up OTLP
 * and the `require`-hook instrumentations, neither of which a unit test wants,
 * and it takes its exporters from configuration rather than from an argument.
 * What a spec needs is the other half — a global tracer, meter, logger and
 * propagator that behave exactly like the real ones — so that the manual
 * instrumentation under test can be asserted on rather than mocked.
 *
 * The API globals are process-wide and survive Jest's module registry, so
 * {@link TelemetryProbe.shutdown} must be called before the file finishes.
 * Without it, every later spec file in the same worker runs against a tracer
 * provider whose exporter belongs to a suite that has already ended.
 */
export function installInMemoryTelemetry(): TelemetryProbe {
  const resource = resourceFromAttributes({ "service.name": "spec" });

  const spanExporter = new InMemorySpanExporter();
  const tracerProvider = new NodeTracerProvider({
    resource,
    // Simple, not batched: a spec asserts immediately after the code under test
    // returns, and a batch processor's first flush is half a second later.
    spanProcessors: [new SimpleSpanProcessor(spanExporter)],
  });
  tracerProvider.register({
    propagator: new CompositePropagator({
      propagators: [new W3CTraceContextPropagator(), new W3CBaggagePropagator()],
    }),
  });

  const logExporter = new InMemoryLogRecordExporter();
  const loggerProvider = new LoggerProvider({
    resource,
    processors: [new SimpleLogRecordProcessor({ exporter: logExporter })],
  });
  logs.setGlobalLoggerProvider(loggerProvider);

  const metricExporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
  const metricReader: MetricReader = new PeriodicExportingMetricReader({
    exporter: metricExporter,
    // Long enough that nothing is exported on a timer: the spec decides when a
    // collection happens, by calling `collectMetrics()`.
    exportIntervalMillis: 2 ** 30,
  });
  const meterProvider = new MeterProvider({ resource, readers: [metricReader] });
  metrics.setGlobalMeterProvider(meterProvider);

  return {
    spans: () => spanExporter.getFinishedSpans(),
    logRecords: () => logExporter.getFinishedLogRecords(),
    collectMetrics: async () => (await metricReader.collect()).resourceMetrics,
    shutdown: async () => {
      await Promise.all([
        tracerProvider.shutdown(),
        loggerProvider.shutdown(),
        meterProvider.shutdown(),
      ]);
      // `disable()` on each global, in the order the API documents: a provider
      // that has been shut down is still the registered one until it is
      // removed, and anything that spans afterwards would be writing into it.
      trace.disable();
      metrics.disable();
      propagation.disable();
      context.disable();
      logs.disable();
    },
  };
}
