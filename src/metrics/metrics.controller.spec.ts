import { ServiceUnavailableException } from "@nestjs/common";
import type { Response } from "express";
import { PROMETHEUS_CONTENT_TYPE, type MetricsScrapeSource } from "@/telemetry";
import { MetricsController } from "./metrics.controller";

const EXPOSITION = ["# HELP jobs_processed_total Jobs.", "jobs_processed_total 7", ""].join("\n");

/** Only the two methods the handler touches, so the spec fails on a third. */
const fakeResponse = () => {
  const headers = new Map<string, string>();
  return {
    headers,
    res: {
      setHeader: (name: string, value: string) => headers.set(name, value),
    } as unknown as Response,
  };
};

describe("MetricsController", () => {
  it("serves the exposition as Prometheus text", async () => {
    const source: MetricsScrapeSource = { scrape: () => Promise.resolve(EXPOSITION) };
    const { res, headers } = fakeResponse();

    await expect(new MetricsController(source).scrape(res)).resolves.toBe(EXPOSITION);
    expect(headers.get("Content-Type")).toBe(PROMETHEUS_CONTENT_TYPE);
    expect(headers.get("Cache-Control")).toBe("no-store");
  });

  /**
   * The deployment that has not turned scraping on, and the one that is
   * draining: `startTelemetry`'s shutdown clears the source before the meter
   * provider is torn down. 503 rather than 404 — an operator who has just
   * pointed a scraper at this is far better served by "not collecting" than by
   * something that reads as a routing mistake — and rather than an empty body,
   * which Prometheus would happily record as a service with no traffic.
   */
  it("answers 503 when nothing is collecting, naming the setting that turns it on", async () => {
    const { res, headers } = fakeResponse();

    await expect(new MetricsController(null).scrape(res)).rejects.toThrow(
      ServiceUnavailableException,
    );
    await expect(new MetricsController(null).scrape(res)).rejects.toThrow(
      /PROMETHEUS_METRICS_ENABLED/,
    );
    expect(headers.size).toBe(0);
  });

  /**
   * The headers are set after the scrape, not through `@Header()`, which Nest
   * applies before the handler runs. Express leaves an already-set
   * `Content-Type` alone, so a header declared up front would label the
   * exception filter's JSON as a Prometheus exposition — which a scraper parses
   * as a malformed metric rather than as the failure it is.
   */
  it("leaves the content type alone when the scrape itself fails", async () => {
    const source: MetricsScrapeSource = {
      scrape: () => Promise.reject(new Error("collect failed")),
    };
    const { res, headers } = fakeResponse();

    await expect(new MetricsController(source).scrape(res)).rejects.toThrow("collect failed");
    expect(headers.size).toBe(0);
  });
});
