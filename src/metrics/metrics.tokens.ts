/**
 * What `MetricsController` is handed.
 *
 * A token rather than a direct call to `installedMetricsScrapeSource()` in the
 * controller, because the thing it resolves to is decided before the container
 * exists and is `null` on most deployments — and a controller that reads a
 * module-scope binding at request time is a controller no test can point
 * anywhere else.
 */
export const METRICS_SCRAPE_SOURCE = Symbol("METRICS_SCRAPE_SOURCE");
