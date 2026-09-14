import { Module } from "@nestjs/common";
import { installedMetricsScrapeSource } from "@/telemetry";
import { MetricsController } from "./metrics.controller";
import { METRICS_SCRAPE_SOURCE } from "./metrics.tokens";

/**
 * Serves what the meter provider has collected, on the port the service already
 * listens on.
 *
 * The module owns no instruments. That is the point of the item this implements
 * and is worth stating where somebody will look for them: the RED data —
 * request rate, error rate and duration, by route and status — is already
 * produced by `instrumentation-http`, which records
 * `http.server.request.duration` for every request the service handles, with
 * `http.route` filled in by the Express instrumentation. A second histogram
 * recorded from a Nest interceptor would carry the same name from a different
 * instrumentation scope, and two metric families with one name is an exposition
 * Prometheus rejects outright. What was missing was never the measurement; it
 * was a way to read it without a collector in the path.
 *
 * The factory resolves once, at module construction. `installMetricsScrapeSource`
 * is called by `startTelemetry` long before `NestFactory.create`, so by the time
 * the container is built the answer is already final — and re-reading it per
 * request would only make the endpoint's behaviour depend on when it was asked.
 */
@Module({
  controllers: [MetricsController],
  providers: [
    {
      provide: METRICS_SCRAPE_SOURCE,
      useFactory: () => installedMetricsScrapeSource(),
    },
  ],
})
export class MetricsModule {}
