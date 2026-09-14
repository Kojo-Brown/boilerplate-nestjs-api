import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MeterProvider } from "@opentelemetry/sdk-metrics";
import { resourceFromAttributes } from "@opentelemetry/resources";
import {
  ATTR_ERROR_TYPE,
  ATTR_HTTP_REQUEST_METHOD,
  ATTR_HTTP_RESPONSE_STATUS_CODE,
  ATTR_HTTP_ROUTE,
  ATTR_SERVER_ADDRESS,
  ATTR_SERVER_PORT,
  METRIC_HTTP_CLIENT_REQUEST_DURATION,
  METRIC_HTTP_SERVER_REQUEST_DURATION,
} from "@opentelemetry/semantic-conventions";
import {
  ATTR_APP_EVENT_NAME,
  ATTR_APP_MESSAGING_OUTCOME,
  ATTR_APP_OUTBOX_DISPOSITION,
} from "@/telemetry/semconv";
import { PrometheusScrapeReader } from "@/telemetry/prometheus-scrape.reader";

const DASHBOARD_PATH = join(
  __dirname,
  "..",
  "..",
  "observability",
  "grafana",
  "dashboards",
  "red-overview.json",
);

/**
 * Labels no instrument produces and every query may still use.
 *
 * `job` and `instance` are attached by Prometheus at scrape time from the
 * scrape config, not by the exposition; `status_class` is synthesised by the
 * `label_replace` in the response-class panel.
 */
const SCRAPER_SUPPLIED_LABELS = new Set(["job", "instance", "status_class"]);

interface Target {
  readonly refId?: string;
  readonly expr?: string;
}

interface Panel {
  readonly id: number;
  readonly type: string;
  readonly title: string;
  readonly datasource?: { type?: string; uid?: string };
  readonly gridPos?: Record<string, number>;
  readonly targets?: Target[];
}

interface TemplateVariable {
  readonly name: string;
  readonly type: string;
  readonly query?: string;
}

interface Dashboard {
  readonly uid: string;
  readonly title: string;
  readonly schemaVersion: number;
  readonly templating: { list: TemplateVariable[] };
  readonly panels: Panel[];
}

const dashboard = JSON.parse(readFileSync(DASHBOARD_PATH, "utf8")) as Dashboard;

const panels = dashboard.panels.filter((panel) => panel.type !== "row");
const targets = panels.flatMap((panel) => panel.targets ?? []);
const expressions = targets.map((target) => target.expr ?? "");
const templateQueries = dashboard.templating.list.map((variable) => variable.query ?? "");

/**
 * The metric names a PromQL expression selects.
 *
 * A selector is an identifier immediately followed by a label matcher or a
 * range — `foo{...}` or `foo[5m]` — which is exactly what distinguishes one
 * from a function call (`rate(`) or a keyword (`by (`). Every query in the
 * dashboard uses one of those two forms, and the count assertion below is what
 * keeps a future query that does not from passing this spec vacuously.
 */
const metricsSelectedBy = (expression: string): string[] =>
  captures(expression, /([a-zA-Z_][a-zA-Z0-9_]*)(?=\s*[{[])/g);

/** `label_values(<metric>, <label>)`, which is a selector the regex above misses. */
const metricsQueriedBy = (query: string): string[] =>
  captures(query, /label_values\(\s*([a-zA-Z_][a-zA-Z0-9_]*)/g);

/** Every label a query matches on or groups by. */
const labelsUsedBy = (expression: string): string[] => [
  ...captures(expression, /\{([^}]*)\}/g).flatMap((braces) =>
    captures(braces, /([a-zA-Z_][a-zA-Z0-9_]*)\s*(?:=~|!~|!=|=)/g),
  ),
  ...captures(expression, /\bby\s*\(([^)]*)\)/g).flatMap((group) =>
    group
      .split(",")
      .map((label) => label.trim())
      .filter((label) => label !== ""),
  ),
];

/** Every first capture group of `pattern` in `subject`. */
function captures(subject: string, pattern: RegExp): string[] {
  return [...subject.matchAll(pattern)]
    .map((match) => match[1])
    .filter((group): group is string => group !== undefined);
}

/**
 * One scrape of every instrument this service actually has, rendered by the
 * reader the endpoint serves from.
 *
 * This is the part that makes the spec worth writing. A dashboard can only be
 * checked against the names that reach Prometheus, and those names are not the
 * instrument names: `http.server.request.duration` is a histogram, so it
 * becomes three series with a `_count`, `_sum` and `_bucket` suffix, dots
 * become underscores, a counter gains `_total` — and this serializer, unlike
 * most Prometheus exporters, does **not** append the unit, so there is no
 * `_seconds` anywhere. Every one of those is a way to write a query that parses
 * perfectly and matches nothing, on a dashboard that then looks exactly like a
 * service with no traffic.
 *
 * The two HTTP instruments are declared with the names
 * `@opentelemetry/instrumentation-http` uses — imported from the semantic
 * conventions package it imports them from, so an upgrade that renames them
 * fails here rather than in a review of an empty panel.
 */
const scrapeOfEveryInstrument = async (): Promise<string> => {
  const reader = new PrometheusScrapeReader();
  const provider = new MeterProvider({
    resource: resourceFromAttributes({ "service.name": "boilerplate-nestjs-api" }),
    readers: [reader],
  });

  const http = provider.getMeter("spec/http");
  http.createHistogram(METRIC_HTTP_SERVER_REQUEST_DURATION, { unit: "s" }).record(0.012, {
    [ATTR_HTTP_REQUEST_METHOD]: "GET",
    [ATTR_HTTP_ROUTE]: "/v1/users/:id",
    [ATTR_HTTP_RESPONSE_STATUS_CODE]: 500,
    [ATTR_ERROR_TYPE]: "500",
  });
  http.createHistogram(METRIC_HTTP_CLIENT_REQUEST_DURATION, { unit: "s" }).record(0.4, {
    [ATTR_HTTP_REQUEST_METHOD]: "POST",
    [ATTR_SERVER_ADDRESS]: "api.stripe.com",
    [ATTR_SERVER_PORT]: 443,
    [ATTR_HTTP_RESPONSE_STATUS_CODE]: 200,
    [ATTR_ERROR_TYPE]: "timeout",
  });

  // The two instruments this codebase writes by hand, with the names and
  // attributes their owners use — `OutboxRelayService` and
  // `DomainEventConsumerService`.
  provider
    .getMeter("spec/outbox")
    .createCounter("outbox.events.drained", { unit: "{event}" })
    .add(1, { [ATTR_APP_OUTBOX_DISPOSITION]: "dead", [ATTR_APP_EVENT_NAME]: "order.placed" });
  provider
    .getMeter("spec/messaging")
    .createHistogram("messaging.process.duration", { unit: "s" })
    .record(0.05, {
      [ATTR_APP_MESSAGING_OUTCOME]: "dead-lettered",
      [ATTR_APP_EVENT_NAME]: "order.placed",
    });

  const exposition = await reader.scrape();
  await provider.shutdown();
  return exposition;
};

describe("the RED dashboard", () => {
  let seriesNames: Set<string>;
  let labelNames: Set<string>;

  beforeAll(async () => {
    const exposition = await scrapeOfEveryInstrument();
    seriesNames = new Set();
    labelNames = new Set();

    for (const line of exposition.split("\n")) {
      const sample = /^([a-zA-Z_][a-zA-Z0-9_]*)(?:\{([^}]*)\})?\s/.exec(line);
      if (line.startsWith("#") || sample?.[1] === undefined) continue;
      seriesNames.add(sample[1]);
      for (const label of captures(sample[2] ?? "", /([a-zA-Z_][a-zA-Z0-9_]*)=/g)) {
        labelNames.add(label);
      }
    }
  });

  it("is valid JSON with the identity Grafana provisions it by", () => {
    expect(dashboard.uid).toBe("boilerplate-nestjs-api-red");
    expect(dashboard.title).toEqual(expect.any(String));
    expect(dashboard.schemaVersion).toBeGreaterThanOrEqual(36);
  });

  it("reads its datasource from a variable rather than pinning one", () => {
    const datasourceVariable = dashboard.templating.list.find(
      (variable) => variable.type === "datasource",
    );

    expect(datasourceVariable?.name).toBe("datasource");
    // A pinned uid is the uid of whichever Grafana the dashboard was exported
    // from, and it resolves to nothing anywhere else.
    for (const panel of panels) {
      expect(panel.datasource).toEqual({ type: "prometheus", uid: "${datasource}" });
    }
  });

  it("gives every panel an id, a title, a position and at least one query", () => {
    const ids = dashboard.panels.map((panel) => panel.id);
    expect(new Set(ids).size).toBe(ids.length);

    for (const panel of panels) {
      expect(panel.title).not.toBe("");
      expect(panel.gridPos).toEqual({
        h: expect.any(Number),
        w: expect.any(Number),
        x: expect.any(Number),
        y: expect.any(Number),
      });
      expect(panel.targets?.length ?? 0).toBeGreaterThan(0);
      for (const target of panel.targets ?? []) {
        expect(target.refId).toEqual(expect.any(String));
        expect(target.expr).toEqual(expect.any(String));
      }
    }
  });

  /**
   * The assertion this file exists for: every series a panel selects is one the
   * reader actually renders. It fails on a renamed instrument, on an upgrade
   * that changes the serializer's suffixes, and on the `_seconds` that a
   * Prometheus habit adds and this exposition does not have.
   */
  it("queries only series the scrape endpoint emits", () => {
    const selected = new Set([
      ...expressions.flatMap(metricsSelectedBy),
      ...templateQueries.flatMap(metricsQueriedBy),
    ]);

    // Not a vacuous pass: every query must have been understood by the
    // extractor above.
    expect(selected.size).toBeGreaterThanOrEqual(4);
    for (const metric of selected) {
      expect({ metric, emitted: seriesNames.has(metric) }).toEqual({ metric, emitted: true });
    }
  });

  it("matches only on labels the instruments carry", () => {
    const used = new Set(expressions.flatMap(labelsUsedBy));

    expect(used.size).toBeGreaterThanOrEqual(4);
    for (const label of used) {
      if (SCRAPER_SUPPLIED_LABELS.has(label)) continue;
      expect({ label, emitted: labelNames.has(label) }).toEqual({ label, emitted: true });
    }
  });

  /**
   * `$__rate_interval` is Grafana's, and it is not interchangeable with
   * `$__interval`: it guarantees a window of at least four scrape intervals, so
   * a panel zoomed in past the scrape period returns a rate rather than the
   * empty result a shorter range produces.
   */
  it("takes every rate over $__rate_interval", () => {
    for (const expression of expressions) {
      for (const range of expression.matchAll(/\[([^\]]+)\]/g)) {
        expect(range[1]).toBe("$__rate_interval");
      }
    }
  });

  /** Rate, errors, duration — the three the item is named for. */
  it("covers all three of R, E and D", () => {
    const all = expressions.join("\n");

    expect(all).toContain("rate(http_server_request_duration_count");
    expect(all).toContain('http_response_status_code=~"5.."');
    expect(all).toContain("histogram_quantile(0.95, sum by (le)");
  });
});
