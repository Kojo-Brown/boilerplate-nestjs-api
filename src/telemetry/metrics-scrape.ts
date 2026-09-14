/**
 * The seam between the SDK, which is built before Nest exists, and the
 * controller that serves what it has collected.
 *
 * Nothing in this file imports the metrics SDK — only the type of the thing
 * that produces an exposition — so `MetricsModule` can depend on it without
 * pulling `@opentelemetry/sdk-metrics` and the Prometheus serializer into every
 * test that builds `AppModule`. The reader itself lives in
 * `prometheus-scrape.reader.ts`, which only `otel-sdk.ts` imports.
 */

/**
 * Whatever can answer a scrape. One method, because that is all the controller
 * needs and all a test has to fake.
 */
export interface MetricsScrapeSource {
  /** The current exposition, in Prometheus text format. */
  scrape(): Promise<string>;
}

/**
 * The `Content-Type` a Prometheus scrape is served with.
 *
 * `version=0.0.4` is the text exposition format, and naming it is not
 * decoration: Prometheus content-negotiates, and a body served as
 * `text/plain` with no version is parsed with the server's fallback rather than
 * the parser this output was written for. `charset=utf-8` because a label value
 * here can carry a route with a non-ASCII segment in it.
 */
export const PROMETHEUS_CONTENT_TYPE = "text/plain; version=0.0.4; charset=utf-8";

/**
 * The installed source, or `null` when metrics are not being scraped.
 *
 * A module-scope binding, which is worth the justification it usually is not.
 * The meter provider is constructed in `startTelemetry`, before `NestFactory`
 * has been called and therefore before any container exists to register a
 * provider in — the same constraint that puts the SDK bootstrap in
 * `register.ts` rather than in a Nest module. `@opentelemetry/api` solves the
 * identical problem the identical way with `metrics.setGlobalMeterProvider`;
 * this is that handoff, narrowed to the one thing the HTTP layer needs.
 *
 * The alternative — `MetricsModule` importing `register.ts` to read the handle
 * — would install the whole SDK in every suite that builds `AppModule`, which
 * is precisely what the barrel's omission of `register` exists to prevent.
 */
let installed: MetricsScrapeSource | null = null;

/**
 * Publishes the source the `/metrics` endpoint serves.
 *
 * Called once, by `startTelemetry`, and only when scraping is enabled. Calling
 * it twice replaces the first: the SDK is installed once per process, and a
 * second installation means a test that is deliberately rebuilding it.
 */
export function installMetricsScrapeSource(source: MetricsScrapeSource): void {
  installed = source;
}

/** The installed source, or `null`. */
export function installedMetricsScrapeSource(): MetricsScrapeSource | null {
  return installed;
}

/**
 * Forgets the installed source.
 *
 * Called from the SDK's `shutdown()`, so the endpoint stops serving from a
 * reader whose meter provider has been shut down — that reader answers every
 * subsequent scrape with an empty exposition, and an empty exposition is
 * indistinguishable from a service that is simply idle. A 503 is the honest
 * answer once the pipeline is gone.
 */
export function clearMetricsScrapeSource(): void {
  installed = null;
}
