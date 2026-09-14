import {
  PROMETHEUS_CONTENT_TYPE,
  clearMetricsScrapeSource,
  installMetricsScrapeSource,
  installedMetricsScrapeSource,
  type MetricsScrapeSource,
} from "./metrics-scrape";

const source = (body: string): MetricsScrapeSource => ({ scrape: () => Promise.resolve(body) });

describe("the metrics scrape seam", () => {
  afterEach(() => {
    clearMetricsScrapeSource();
  });

  it("reports nothing installed until the SDK installs one", () => {
    expect(installedMetricsScrapeSource()).toBeNull();

    installMetricsScrapeSource(source("# HELP up\n"));

    expect(installedMetricsScrapeSource()).not.toBeNull();
  });

  /**
   * What `startTelemetry`'s `shutdown()` does before the meter provider is torn
   * down. A shut-down reader answers every collection with an empty exposition,
   * and an empty exposition is indistinguishable from an idle service — so the
   * endpoint has to stop serving rather than start lying.
   */
  it("forgets the source on shutdown", () => {
    installMetricsScrapeSource(source("# HELP up\n"));
    clearMetricsScrapeSource();

    expect(installedMetricsScrapeSource()).toBeNull();
  });

  it("replaces the source when one is installed twice", async () => {
    installMetricsScrapeSource(source("first"));
    installMetricsScrapeSource(source("second"));

    await expect(installedMetricsScrapeSource()?.scrape()).resolves.toBe("second");
  });

  /**
   * Prometheus content-negotiates, and a body served as bare `text/plain` is
   * parsed with the server's fallback rather than with the parser this format
   * was written for.
   */
  it("names the exposition format in the content type", () => {
    expect(PROMETHEUS_CONTENT_TYPE).toBe("text/plain; version=0.0.4; charset=utf-8");
  });
});
