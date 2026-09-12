import type { OtelExporterName, TelemetryEnv } from "./telemetry.env";

/**
 * Everything the SDK needs, resolved once and never read from the environment
 * again.
 *
 * A plain object rather than a `ConfigService` lookup because this is built
 * before Nest exists — see `register.ts` — and because a pure value is what
 * lets the composition in `otel-sdk.ts` be exercised without starting anything.
 */
export interface TelemetryOptions {
  readonly exporter: OtelExporterName;
  readonly serviceName: string;
  /** `null` when unset, so the attribute is omitted rather than invented. */
  readonly serviceVersion: string | null;
  /** `deployment.environment.name`, taken from `NODE_ENV`. */
  readonly environment: string;
  /** Base URL, without a signal path. `null` unless `exporter` is `otlp`. */
  readonly otlpEndpoint: string | null;
  readonly otlpHeaders: Readonly<Record<string, string>>;
  readonly samplerRatio: number;
  readonly metricExportIntervalMs: number;
  readonly shutdownTimeoutMs: number;
}

/** OTLP/HTTP signal paths, as the specification fixes them. */
export const OTLP_SIGNAL_PATHS = {
  traces: "/v1/traces",
  metrics: "/v1/metrics",
  logs: "/v1/logs",
} as const;

export function telemetryOptionsFrom(env: TelemetryEnv, nodeEnv: string): TelemetryOptions {
  return {
    exporter: env.OTEL_EXPORTER,
    serviceName: env.OTEL_SERVICE_NAME,
    serviceVersion: env.OTEL_SERVICE_VERSION ?? null,
    environment: nodeEnv,
    otlpEndpoint: env.OTEL_EXPORTER === "otlp" ? (env.OTEL_EXPORTER_OTLP_ENDPOINT ?? null) : null,
    otlpHeaders: parseOtlpHeaders(env.OTEL_EXPORTER_OTLP_HEADERS),
    samplerRatio: env.OTEL_TRACES_SAMPLER_ARG,
    metricExportIntervalMs: env.OTEL_METRIC_EXPORT_INTERVAL_MS,
    shutdownTimeoutMs: env.OTEL_SHUTDOWN_TIMEOUT_MS,
  };
}

/**
 * The URL one signal is posted to.
 *
 * `OTEL_EXPORTER_OTLP_ENDPOINT` is a *base*, and the exporters take a fully
 * qualified URL — pass the base straight through and every signal is posted to
 * the collector's root, which answers 404 and drops the batch. Trailing slashes
 * are stripped first, because `http://collector:4318/` + `/v1/traces` is a path
 * with an empty segment in it and not every collector normalises that away.
 */
export function signalEndpoint(base: string, signalPath: string): string {
  return `${base.replace(/\/+$/, "")}${signalPath}`;
}

/**
 * `OTEL_EXPORTER_OTLP_HEADERS` as a header map.
 *
 * The format is the specification's: `key=value` pairs separated by commas,
 * with percent-encoded values. Two details are worth the code rather than a
 * `split("=")`:
 *
 * - only the *first* `=` separates the pair. A `Basic` credential is base64,
 *   and base64 padding is `=` — splitting on every occurrence truncates the
 *   token and produces a header that authenticates nothing.
 * - a malformed entry throws rather than being skipped. This value is usually
 *   the collector's credential, and an export pipeline that silently drops its
 *   own authentication fails at the far end, in somebody else's logs, as a 401
 *   the SDK reports only on its internal diagnostic channel.
 */
export function parseOtlpHeaders(raw: string | undefined): Readonly<Record<string, string>> {
  if (raw === undefined || raw.trim() === "") return {};

  const headers: Record<string, string> = {};
  for (const entry of raw.split(",")) {
    const trimmed = entry.trim();
    if (trimmed === "") continue;

    const separator = trimmed.indexOf("=");
    const key = separator === -1 ? "" : trimmed.slice(0, separator).trim();
    if (key === "") {
      throw new Error(
        `OTEL_EXPORTER_OTLP_HEADERS entry "${trimmed}" is not a "key=value" pair. ` +
          `The format is a comma-separated list, for example ` +
          `"api-key=<token>,x-tenant=acme".`,
      );
    }
    headers[key] = decodeURIComponent(trimmed.slice(separator + 1).trim());
  }
  return headers;
}
