import { ValueType, diag } from "@opentelemetry/api";
import { MeterProvider } from "@opentelemetry/sdk-metrics";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { PrometheusScrapeReader } from "./prometheus-scrape.reader";

/**
 * A provider built the way `startTelemetry` builds one, so the spec exercises
 * the reader through the same seam the application uses rather than through
 * `collect()` directly.
 */
const providerWith = (reader: PrometheusScrapeReader) =>
  new MeterProvider({
    resource: resourceFromAttributes({ "service.name": "spec-service" }),
    readers: [reader],
  });

describe("PrometheusScrapeReader", () => {
  let reader: PrometheusScrapeReader;
  let provider: MeterProvider;

  beforeEach(() => {
    reader = new PrometheusScrapeReader();
    provider = providerWith(reader);
  });

  afterEach(async () => {
    await provider.shutdown();
  });

  it("renders a histogram as the three series Prometheus expects", async () => {
    provider
      .getMeter("spec")
      .createHistogram("http.server.request.duration", { unit: "s", valueType: ValueType.DOUBLE })
      .record(0.25, { "http.route": "/v1/users/:id", "http.response.status_code": 200 });

    const exposition = await reader.scrape();

    expect(exposition).toContain("# TYPE http_server_request_duration histogram");
    expect(exposition).toMatch(/http_server_request_duration_count\{[^}]*} 1$/m);
    expect(exposition).toMatch(/http_server_request_duration_sum\{[^}]*} 0\.25$/m);
    expect(exposition).toMatch(/http_server_request_duration_bucket\{[^}]*le="\+Inf"} 1$/m);
  });

  /**
   * The naming rule the dashboard depends on, and the one that is easy to get
   * wrong from memory: this serializer records the unit on a `# UNIT` line and
   * does **not** append it to the metric name. A query written against
   * `http_server_request_duration_seconds_bucket` — which is what a Prometheus
   * habit produces, and what most other exporters emit — matches nothing, and a
   * dashboard of empty panels looks exactly like a service with no traffic.
   */
  it("does not suffix the metric name with its unit", async () => {
    provider
      .getMeter("spec")
      .createHistogram("http.server.request.duration", { unit: "s" })
      .record(0.25);

    const exposition = await reader.scrape();

    expect(exposition).toContain("# UNIT http_server_request_duration s");
    expect(exposition).not.toContain("http_server_request_duration_seconds");
  });

  it("renders a counter with the _total suffix and dotted attributes as underscored labels", async () => {
    provider
      .getMeter("spec")
      .createCounter("outbox.events.drained", { unit: "{event}" })
      .add(2, { "app.outbox.disposition": "dead" });

    const exposition = await reader.scrape();

    expect(exposition).toContain("# TYPE outbox_events_drained_total counter");
    expect(exposition).toMatch(/outbox_events_drained_total\{[^}]*app_outbox_disposition="dead"/);
  });

  /**
   * The property that makes `rate()` correct. A delta reader would reset on
   * every collection, so each scrape would report only what happened since the
   * last one — and two Prometheus replicas scraping the same pod would each see
   * a fraction of the traffic, with nothing in the output saying so.
   */
  it("accumulates across scrapes rather than resetting", async () => {
    const counter = provider.getMeter("spec").createCounter("jobs.processed");

    counter.add(1);
    await reader.scrape();
    counter.add(1);

    expect(await reader.scrape()).toMatch(/^jobs_processed_total\{[^}]*} 2$/m);
  });

  /**
   * Prometheus stamps a sample with the time of the scrape. An exposition that
   * carries its own timestamps overrides that with the time the SDK last
   * aggregated, which is what staleness detection keys off: a series that stops
   * being exported then lingers at its last value instead of going stale.
   */
  it("emits no per-sample timestamps", async () => {
    provider.getMeter("spec").createCounter("jobs.processed").add(1);

    const sample = (await reader.scrape())
      .split("\n")
      .find((line) => line.startsWith("jobs_processed_total"));

    // `<name>{<labels>} <value>` and nothing after it. A timestamp would be a
    // second space-separated field.
    expect(sample).toMatch(/^jobs_processed_total\{[^}]*} \d+$/);
  });

  it("carries the resource as target_info", async () => {
    expect(await reader.scrape()).toContain('target_info{service_name="spec-service"} 1');
  });

  /**
   * A monitoring endpoint that answers 500 during an incident is the worst
   * possible moment to lose the rest of the numbers, so a callback that throws
   * costs its own series and nothing else.
   */
  it("serves what it collected when an observable callback throws", async () => {
    const warn = jest.spyOn(diag, "warn").mockImplementation(() => undefined);
    const meter = provider.getMeter("spec");
    meter.createCounter("jobs.processed").add(1);
    meter.createObservableGauge("queue.depth").addCallback(() => {
      throw new Error("the queue is unreachable");
    });

    const exposition = await reader.scrape();

    expect(exposition).toContain("jobs_processed_total");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("the queue is unreachable"));
    warn.mockRestore();
  });

  it("flushes and shuts down without doing anything", async () => {
    await expect(reader.forceFlush()).resolves.toBeUndefined();
    await expect(reader.shutdown()).resolves.toBeUndefined();
  });
});
