import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { createTestApp } from "./helpers/create-test-app";
import {
  PROMETHEUS_CONTENT_TYPE,
  clearMetricsScrapeSource,
  installMetricsScrapeSource,
} from "@/telemetry";

const EXPOSITION = [
  "# HELP http_server_request_duration Duration of HTTP server requests.",
  "# TYPE http_server_request_duration histogram",
  'http_server_request_duration_count{http_route="/v1/users"} 3',
  "",
].join("\n");

/** A `Content-Type` as its type plus its parameters, so order stops mattering. */
const mediaType = (header: string | undefined) => {
  const [type = "", ...parameters] = (header ?? "").split(";").map((part) => part.trim());
  return { type, parameters: parameters.sort() };
};

/**
 * The endpoint over a real router, which is the half `metrics.controller.spec.ts`
 * cannot reach: that the path is `/metrics` and not `/v1/metrics` under URI
 * versioning, that the global response envelope leaves the body alone, and that
 * the deployment which has not turned collection on gets a 503 rather than a
 * 404 or an empty 200.
 *
 * The scrape source is installed by hand rather than by starting the SDK. The
 * instrumentations patch `http` and `express` as they are required, and by the
 * time a Jest suite runs, both have been required long ago — so an SDK started
 * here would produce an exposition with no HTTP metrics in it, and a spec that
 * asserted on one would be asserting on the harness rather than on the service.
 * What the two claims above need is a source, not a real one.
 */
describe("Prometheus metrics endpoint (e2e)", () => {
  describe("when metrics are being collected", () => {
    let app: INestApplication;

    beforeAll(async () => {
      // Before the app is built: `MetricsModule` resolves the source once, at
      // module construction, exactly as it does in a process where
      // `startTelemetry` ran before `NestFactory.create`.
      installMetricsScrapeSource({ scrape: () => Promise.resolve(EXPOSITION) });
      app = (await createTestApp()).app;
    });

    afterAll(async () => {
      await app.close();
      clearMetricsScrapeSource();
    });

    it("serves the exposition verbatim, as Prometheus text", async () => {
      const res = await request(app.getHttpServer()).get("/metrics").expect(200);

      // Compared as a parsed media type rather than as a string: Express
      // re-serialises the header on `send()` — it appends the charset for a
      // string body and writes the parameters back in alphabetical order, so
      // what goes out is `text/plain; charset=utf-8; version=0.0.4`. Parameter
      // order carries no meaning to a parser, and asserting on the literal
      // would be asserting on Express's formatter.
      expect(mediaType(res.headers["content-type"])).toEqual(mediaType(PROMETHEUS_CONTENT_TYPE));
      expect(res.headers["cache-control"]).toBe("no-store");
      // Not wrapped in `{ success, data, meta }`: an envelope would make this
      // unparseable by everything that scrapes.
      expect(res.text).toBe(EXPOSITION);
    });

    it("is not versioned, because a scraper is pointed at /metrics", async () => {
      await request(app.getHttpServer()).get("/v1/metrics").expect(404);
    });
  });

  describe("when nothing is collecting", () => {
    let app: INestApplication;

    beforeAll(async () => {
      clearMetricsScrapeSource();
      app = (await createTestApp()).app;
    });

    afterAll(async () => {
      await app.close();
    });

    it("answers 503 naming the setting that turns collection on", async () => {
      const res = await request(app.getHttpServer()).get("/metrics").expect(503);

      expect(JSON.stringify(res.body)).toContain("PROMETHEUS_METRICS_ENABLED");
    });
  });
});
