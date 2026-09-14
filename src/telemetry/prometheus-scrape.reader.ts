import { diag } from "@opentelemetry/api";
import { PrometheusSerializer } from "@opentelemetry/exporter-prometheus";
import {
  AggregationTemporality,
  MetricReader,
  type CollectionResult,
} from "@opentelemetry/sdk-metrics";
import type { MetricsScrapeSource } from "./metrics-scrape";

/**
 * A pull-based metric reader that renders the exposition on demand.
 *
 * This is deliberately **not** `PrometheusExporter` from
 * `@opentelemetry/exporter-prometheus`, even though that class is a
 * `MetricReader` too and would have been two lines. It opens an HTTP server of
 * its own on a second port, and a second listener is a second thing to expose
 * through the service mesh, a second port in the Helm chart, a second surface
 * that answers before the application is ready and after it has stopped
 * draining, and one that no interceptor, guard or exception filter in this
 * codebase sits in front of. Serving the scrape from a Nest controller on the
 * port the service already listens on keeps all of that in one place. What is
 * borrowed from the package is the part worth borrowing: `PrometheusSerializer`
 * is the specification-conformant OTLP→Prometheus name and label translation,
 * and hand-rolling that is how an exposition ends up with a label the scraper
 * rejects.
 *
 * The reader is passed to the `MeterProvider` at construction because SDK 2.x
 * fixes its readers there; `collect()` then pulls from every instrument the
 * provider knows about, the auto-instrumentation's histograms included.
 */
export class PrometheusScrapeReader extends MetricReader implements MetricsScrapeSource {
  private readonly serializer: PrometheusSerializer;

  constructor() {
    super({
      /**
       * Cumulative, for every instrument type, and not by accident.
       *
       * Prometheus's data model is cumulative: `rate()` reconstructs the
       * per-second change from the difference between two scrapes, and it
       * needs the counter to be monotonic across them to do it. A delta reader
       * resets its accumulation on every collection, so a scrape would report
       * "what happened since the last scrape" as though it were a total — and
       * two Prometheus replicas scraping the same pod would each see a
       * fraction of the traffic, with no way to tell that they had.
       *
       * Cumulative is the SDK's default, and it is stated here anyway: the
       * default is a default, and this reader is incorrect under any other
       * value.
       */
      aggregationTemporalitySelector: () => AggregationTemporality.CUMULATIVE,
    });

    this.serializer = new PrometheusSerializer(
      // No prefix. A `job` label is how a Prometheus setup distinguishes
      // services, and a per-service metric-name prefix would put this
      // service's `http.server.request.duration` under a different name from
      // every other service's, which is the one thing that makes a shared
      // dashboard impossible.
      undefined,
      // No timestamps. Prometheus stamps a sample with the time of the scrape,
      // and an exposition that carries its own timestamps overrides that with
      // the time the SDK last aggregated — which is what staleness detection
      // keys off. A series that stops being exported then lingers instead of
      // going stale.
      false,
    );
  }

  /**
   * Nothing to flush, and nothing to close.
   *
   * Both are the push-exporter hooks: a periodic reader exports on force-flush
   * and tears down its timer on shutdown. A pull reader holds neither a buffer
   * nor a connection — the data lives in the meter provider until somebody
   * asks for it — so the honest implementation of both is to resolve.
   */
  protected onForceFlush(): Promise<void> {
    return Promise.resolve();
  }

  protected onShutdown(): Promise<void> {
    return Promise.resolve();
  }

  /**
   * The current exposition, in Prometheus text format.
   *
   * A partial collection is served rather than failed. `collect()` reports the
   * errors thrown by *observable* instruments' callbacks alongside the metrics
   * it did gather, and one broken callback should not take down the scrape for
   * everything else in the process — a monitoring endpoint that answers 500
   * during an incident is the worst possible moment to lose the rest of the
   * numbers. The failures go to the SDK's diagnostic channel, which is where
   * the rest of the SDK's own faults are reported.
   */
  async scrape(): Promise<string> {
    const collected: CollectionResult = await this.collect();

    for (const error of collected.errors) {
      diag.warn(`Metric collection reported an error during scrape: ${String(error)}`);
    }

    return this.serializer.serialize(collected.resourceMetrics);
  }
}
