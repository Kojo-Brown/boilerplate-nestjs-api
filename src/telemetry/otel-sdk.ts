import { diag, DiagConsoleLogger, DiagLogLevel, metrics } from "@opentelemetry/api";
import { logs } from "@opentelemetry/api-logs";
import {
  CompositePropagator,
  W3CBaggagePropagator,
  W3CTraceContextPropagator,
} from "@opentelemetry/core";
import { defaultResource, resourceFromAttributes, type Resource } from "@opentelemetry/resources";
import {
  AlwaysOffSampler,
  BatchSpanProcessor,
  ConsoleSpanExporter,
  ParentBasedSampler,
  TraceIdRatioBasedSampler,
  type Sampler,
  type SpanExporter,
} from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import {
  ConsoleMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader,
  type IMetricReader,
  type PushMetricExporter,
} from "@opentelemetry/sdk-metrics";
import {
  BatchLogRecordProcessor,
  ConsoleLogRecordExporter,
  LoggerProvider,
  type LogRecordExporter,
  type LogRecordProcessor,
} from "@opentelemetry/sdk-logs";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-http";
import { registerInstrumentations } from "@opentelemetry/instrumentation";
import { HttpInstrumentation } from "@opentelemetry/instrumentation-http";
import { ExpressInstrumentation } from "@opentelemetry/instrumentation-express";
import { UndiciInstrumentation } from "@opentelemetry/instrumentation-undici";
import {
  ATTR_DEPLOYMENT_ENVIRONMENT_NAME,
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
} from "@opentelemetry/semantic-conventions";
import { OTLP_SIGNAL_PATHS, signalEndpoint, type TelemetryOptions } from "./telemetry.options";
import { clearMetricsScrapeSource, installMetricsScrapeSource } from "./metrics-scrape";
import { PrometheusScrapeReader } from "./prometheus-scrape.reader";

/**
 * Paths that are never worth a trace.
 *
 * A liveness probe runs every few seconds forever, a Swagger asset is a static
 * file, and neither has ever been the thing somebody opened a trace viewer to
 * find. Left in, they are the overwhelming majority of spans in a quiet
 * service: the sampling ratio then spends itself on probes, and the one
 * interesting request in the window is the one that gets dropped.
 *
 * Prefixes rather than exact paths, because `/v1/health` is one route today and
 * `/v1/health/ready` is the next one somebody adds.
 *
 * `/metrics` is here for a second reason on top of the noise: it is the scrape
 * endpoint, so leaving it in would put the monitoring system's own traffic into
 * the numbers the monitoring system reads. A scrape every fifteen seconds is a
 * request rate that never varies and never errs, and on a quiet service it is
 * most of the request rate — enough to hide a real one going to zero.
 */
export const UNTRACED_PATH_PREFIXES = [
  "/v1/health",
  "/health",
  "/metrics",
  "/docs",
  "/favicon.ico",
] as const;

/** What `startTelemetry` hands back, so `main.ts` can flush on the way out. */
export interface TelemetryHandle {
  /** False when `OTEL_EXPORTER=none`: nothing was installed and nothing needs flushing. */
  readonly enabled: boolean;
  /**
   * Flushes and stops every provider. Idempotent, and never rejects: a
   * collector that has stopped answering must not be able to fail a shutdown
   * that is otherwise clean.
   */
  shutdown(): Promise<void>;
}

const DISABLED: TelemetryHandle = { enabled: false, shutdown: () => Promise.resolve() };

/**
 * Installs the OpenTelemetry SDK, or does nothing at all.
 *
 * Called from `register.ts` before any application module is loaded, which is a
 * requirement rather than a preference: `HttpInstrumentation` and
 * `ExpressInstrumentation` work by patching the exports of `http` and `express`
 * as they are required, so a module loaded first is a module that is never
 * instrumented.
 *
 * With `OTEL_EXPORTER=none` and no Prometheus scrape this returns immediately
 * and registers *nothing* — no tracer provider, no meter provider, no
 * propagator, no instrumentation. The `@opentelemetry/api` globals then stay at
 * their built-in no-op implementations, so `tracer.startActiveSpan(...)` in the
 * outbox publisher runs its callback and allocates nothing, and the manual
 * instrumentation scattered through this codebase costs approximately a
 * function call. That is what makes it safe to leave it in place
 * unconditionally — see `docs/telemetry.md`.
 *
 * `PROMETHEUS_METRICS_ENABLED=true` with the exporter still at `none` is the
 * Prometheus-only deployment, and it installs the metrics half and only the
 * metrics half: the meter provider with the scrape reader, and the
 * instrumentations, because the RED data is theirs. There is still a tracer
 * provider, and it is registered for one reason that has nothing to do with
 * traces — see the sampler below.
 */
export function startTelemetry(options: TelemetryOptions): TelemetryHandle {
  // "Pushing" is the distinction that matters below, not the exporter's name:
  // traces and logs have nowhere to go without one, metrics still do.
  const pushing = options.exporter !== "none";
  if (!pushing && !options.prometheusScrape) return DISABLED;

  // The SDK reports its own failures — an unreachable collector, a rejected
  // batch — on this channel and nowhere else. Left unset it is silent, which is
  // how an export pipeline ends up broken for a week with nothing in the logs.
  diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.WARN);

  const resource = buildResource(options);

  const tracerProvider = new NodeTracerProvider({
    resource,
    /**
     * `AlwaysOff` when nothing is being pushed, and the provider registered
     * all the same.
     *
     * The registration is what installs the context manager, and the context
     * manager is what carries `http.route` from the Express instrumentation to
     * the HTTP instrumentation's metric attributes: the route is written onto
     * the RPC metadata in the active context, not onto the span, so it
     * survives a span that is never recorded but not a context that is never
     * propagated. Without this, every series in the exposition collapses onto
     * one route-less line and the per-route half of RED is gone.
     *
     * The sampler then makes each of those spans a non-recording one, which
     * costs an object with a span context and no attributes, no events and no
     * export path.
     */
    sampler: pushing ? buildSampler(options.samplerRatio) : new AlwaysOffSampler(),
    spanProcessors: pushing ? [new BatchSpanProcessor(buildSpanExporter(options))] : [],
  });
  // `register()` is what makes `trace.getTracer()` return this provider and
  // installs the context manager that keeps the active span attached across
  // `await` boundaries. The propagator is passed here rather than left to
  // default, because that default is the traceparent header alone: baggage is
  // how a tenant or a request attribute reaches a service three hops away, and
  // a propagator that drops it loses it silently.
  tracerProvider.register({
    propagator: new CompositePropagator({
      propagators: [new W3CTraceContextPropagator(), new W3CBaggagePropagator()],
    }),
  });

  // Both readers can be present at once, and that is a supported deployment
  // rather than an oversight: the same instruments are collected twice, pushed
  // to the collector on a timer and rendered on demand for the scraper, with
  // each reader keeping its own accumulation. It is how a migration between the
  // two is run without a window where neither is recording.
  const metricReaders: IMetricReader[] = [];
  const scrapeReader = options.prometheusScrape ? new PrometheusScrapeReader() : null;
  if (scrapeReader !== null) metricReaders.push(scrapeReader);
  if (pushing) {
    metricReaders.push(
      new PeriodicExportingMetricReader({
        exporter: buildMetricExporter(options),
        exportIntervalMillis: options.metricExportIntervalMs,
      }),
    );
  }

  const meterProvider = new MeterProvider({ resource, readers: metricReaders });
  metrics.setGlobalMeterProvider(meterProvider);
  // After the provider is global, so the endpoint cannot start serving from a
  // reader whose instruments have not been bound yet.
  if (scrapeReader !== null) installMetricsScrapeSource(scrapeReader);

  // No logger provider when nothing is being pushed: a log record has no
  // pull-based exposition to appear in, so installing one would buffer records
  // in a batch processor that never has anywhere to send them. The API global
  // stays no-op and `TelemetryLogger` degrades to the stock `ConsoleLogger`.
  const loggerProvider = pushing
    ? new LoggerProvider({ resource, processors: [buildLogRecordProcessor(options)] })
    : null;
  if (loggerProvider !== null) logs.setGlobalLoggerProvider(loggerProvider);

  registerInstrumentations({
    instrumentations: [
      new HttpInstrumentation({
        // Server spans for probes and Swagger assets are noise; see
        // UNTRACED_PATH_PREFIXES. The outgoing side is deliberately not
        // filtered — an outbound call this service makes is always something
        // somebody will want to see in the trace.
        ignoreIncomingRequestHook: (request) => isUntracedPath(request.url),
      }),
      // Turns one flat server span into the route that handled it: without it
      // every request is `POST /v1/*` and no middleware is visible, which is
      // most of what makes a slow request explicable.
      new ExpressInstrumentation(),
      // Node's global `fetch` is undici, and `requestJson()` in
      // `common/http` uses it exclusively. This is therefore the
      // instrumentation that puts `traceparent` on every outbound call to
      // Stripe, PayPal, Twilio and Expo — the client half of the propagation
      // this item is about.
      new UndiciInstrumentation(),
    ],
  });

  return {
    enabled: true,
    shutdown: async () => {
      // Before the provider is torn down, not after: a shut-down reader answers
      // every collection with an empty exposition, and an empty exposition is
      // indistinguishable from an idle service. The endpoint answers 503 from
      // here on instead, which is what a draining pod should be telling its
      // scraper anyway.
      clearMetricsScrapeSource();

      const providers = [
        tracerProvider,
        meterProvider,
        ...(loggerProvider ? [loggerProvider] : []),
      ];
      // Settled rather than all: a collector that is refusing connections
      // rejects one of these, and the others still have a batch to flush.
      const results = await Promise.allSettled(
        providers.map((provider) => withTimeout(provider.shutdown(), options.shutdownTimeoutMs)),
      );
      for (const result of results) {
        if (result.status === "rejected") {
          diag.warn(`Telemetry shutdown did not complete cleanly: ${String(result.reason)}`);
        }
      }
      // After the providers are gone, leave the API globals no-op rather than
      // pointing at a shut-down provider: anything that logs or spans during
      // the rest of shutdown would otherwise be writing into a closed pipeline.
      diag.disable();
    },
  };
}

/**
 * The resource every signal carries.
 *
 * `defaultResource()` is merged in rather than replaced, so `telemetry.sdk.*`
 * and the process attributes survive; the explicit attributes win on conflict,
 * which is what makes `OTEL_SERVICE_NAME` authoritative over the SDK's
 * `unknown_service:node` fallback.
 */
export function buildResource(options: TelemetryOptions): Resource {
  const attributes: Record<string, string> = {
    [ATTR_SERVICE_NAME]: options.serviceName,
    [ATTR_DEPLOYMENT_ENVIRONMENT_NAME]: options.environment,
  };
  if (options.serviceVersion !== null) {
    attributes[ATTR_SERVICE_VERSION] = options.serviceVersion;
  }
  return defaultResource().merge(resourceFromAttributes(attributes));
}

/**
 * Parent-based, with a ratio at the root.
 *
 * The parent-based wrapper is the part that makes a distributed trace hold
 * together: a request that arrives with `traceparent` inherits that trace's
 * sampled flag instead of drawing again. Sampling independently at each hop
 * produces traces with holes in them — the gateway kept the request, this
 * service dropped it, and the resulting trace shows a call that apparently went
 * nowhere — and the holes get exponentially more likely the more services a
 * request passes through.
 *
 * The ratio therefore applies only where this service *starts* a trace, and it
 * is a hash of the trace id rather than a coin flip, so every service in the
 * trace that consults it reaches the same verdict.
 */
export function buildSampler(ratio: number): Sampler {
  return new ParentBasedSampler({ root: new TraceIdRatioBasedSampler(ratio) });
}

/** True when a request path is one of {@link UNTRACED_PATH_PREFIXES}. */
export function isUntracedPath(url: string | undefined): boolean {
  if (url === undefined) return false;
  // The query string is not part of the decision, and `?` is the only thing
  // separating `/v1/health` from `/v1/health?verbose=1`.
  const path = url.split("?")[0] ?? url;
  return UNTRACED_PATH_PREFIXES.some(
    (prefix) => path === prefix || path.startsWith(`${prefix}/`) || path.startsWith(`${prefix}?`),
  );
}

function buildSpanExporter(options: TelemetryOptions): SpanExporter {
  if (options.exporter === "console") return new ConsoleSpanExporter();
  return new OTLPTraceExporter({
    url: signalEndpoint(requireEndpoint(options), OTLP_SIGNAL_PATHS.traces),
    headers: { ...options.otlpHeaders },
  });
}

function buildMetricExporter(options: TelemetryOptions): PushMetricExporter {
  if (options.exporter === "console") return new ConsoleMetricExporter();
  return new OTLPMetricExporter({
    url: signalEndpoint(requireEndpoint(options), OTLP_SIGNAL_PATHS.metrics),
    headers: { ...options.otlpHeaders },
  });
}

function buildLogRecordProcessor(options: TelemetryOptions): LogRecordProcessor {
  const exporter: LogRecordExporter =
    options.exporter === "console"
      ? new ConsoleLogRecordExporter()
      : new OTLPLogExporter({
          url: signalEndpoint(requireEndpoint(options), OTLP_SIGNAL_PATHS.logs),
          headers: { ...options.otlpHeaders },
        });
  return new BatchLogRecordProcessor({ exporter });
}

/**
 * The endpoint, or an error naming the variable.
 *
 * `telemetryEnvSchema` already refuses `OTEL_EXPORTER=otlp` without one, so
 * reaching this throw means `startTelemetry` was handed options that did not
 * come through the schema — a test, or a future caller. Better a message that
 * says which setting is missing than a `null` widening into the exporter's own
 * default of `http://localhost:4318`.
 */
function requireEndpoint(options: TelemetryOptions): string {
  if (options.otlpEndpoint === null) {
    throw new Error("OTEL_EXPORTER_OTLP_ENDPOINT is required when OTEL_EXPORTER=otlp");
  }
  return options.otlpEndpoint;
}

/**
 * Bounds one provider's shutdown.
 *
 * The SDK's own `shutdown()` waits for the in-flight export, and an export to a
 * collector that accepted the connection and then stopped reading waits for the
 * socket timeout — which is longer than the process's whole shutdown budget.
 */
function withTimeout(work: Promise<void>, timeoutMs: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const expiry = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  return Promise.race([work, expiry]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}
