import {
  Controller,
  Get,
  Inject,
  Res,
  ServiceUnavailableException,
  VERSION_NEUTRAL,
} from "@nestjs/common";
import {
  ApiOkResponse,
  ApiOperation,
  ApiServiceUnavailableResponse,
  ApiTags,
} from "@nestjs/swagger";
import type { Response } from "express";
import { SkipResponseEnvelope } from "@/common/decorators/skip-response-envelope.decorator";
import { PROMETHEUS_CONTENT_TYPE, type MetricsScrapeSource } from "@/telemetry";
import { METRICS_SCRAPE_SOURCE } from "./metrics.tokens";

/**
 * The Prometheus scrape endpoint.
 *
 * `VERSION_NEUTRAL`, so the path is `/metrics` and not `/v1/metrics`. Every
 * other route here is versioned and should be: a REST resource has a contract
 * with its clients. This one's client is the scraper, `/metrics` is where every
 * scraper is pointed by default, and the exposition's compatibility story is
 * the metric names inside it rather than the path — which is why a `/v2` of it
 * would mean nothing.
 *
 * The response is text, not JSON, so `@SkipResponseEnvelope()` is not a
 * preference: an exposition wrapped in `{ success, data, meta }` is not
 * parseable by anything that scrapes.
 */
@ApiTags("metrics")
@Controller({ path: "metrics", version: VERSION_NEUTRAL })
export class MetricsController {
  constructor(@Inject(METRICS_SCRAPE_SOURCE) private readonly source: MetricsScrapeSource | null) {}

  @Get()
  @SkipResponseEnvelope()
  @ApiOperation({
    summary: "Prometheus metrics",
    description:
      "The current metric exposition in Prometheus text format, rendered on demand from the " +
      "OpenTelemetry meter provider. Enabled by PROMETHEUS_METRICS_ENABLED=true; answers 503 " +
      "otherwise, and while the process is shutting down.",
  })
  @ApiOkResponse({
    description: "The exposition, in Prometheus text format 0.0.4.",
    content: {
      "text/plain": {
        schema: { type: "string" },
        example:
          "# HELP http_server_request_duration Duration of HTTP server requests.\n" +
          "# TYPE http_server_request_duration histogram\n" +
          'http_server_request_duration_count{http_request_method="GET",http_route="/v1/users"} 3\n',
      },
    },
  })
  @ApiServiceUnavailableResponse({ description: "Metrics are not being collected." })
  async scrape(@Res({ passthrough: true }) res: Response): Promise<string> {
    if (this.source === null) {
      throw new ServiceUnavailableException(
        "Metrics are not being collected. Set PROMETHEUS_METRICS_ENABLED=true to install the " +
          "meter provider and the instrumentations that feed it.",
      );
    }

    const exposition = await this.source.scrape();

    // Set after the scrape rather than through `@Header()`, which Nest applies
    // before the handler runs: the 503 above, and any failure inside the
    // collection, is rendered as JSON by `AllExceptionsFilter`, and Express
    // leaves a `Content-Type` that is already set alone — so a header declared
    // up front would label that JSON as a Prometheus exposition.
    res.setHeader("Content-Type", PROMETHEUS_CONTENT_TYPE);
    // A scrape is a point-in-time reading and every scraper stamps it with its
    // own clock. Nothing between here and Prometheus has any business serving a
    // cached copy of one.
    res.setHeader("Cache-Control", "no-store");

    return exposition;
  }
}
