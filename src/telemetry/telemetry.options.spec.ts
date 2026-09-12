import { telemetryEnvSchema } from "./telemetry.env";
import {
  OTLP_SIGNAL_PATHS,
  parseOtlpHeaders,
  signalEndpoint,
  telemetryOptionsFrom,
} from "./telemetry.options";

describe("signalEndpoint", () => {
  it("appends the signal path to the base endpoint", () => {
    expect(signalEndpoint("http://collector:4318", OTLP_SIGNAL_PATHS.traces)).toBe(
      "http://collector:4318/v1/traces",
    );
  });

  /**
   * `http://collector:4318/` is what an operator pastes out of a console, and
   * naive concatenation turns it into `//v1/metrics` — a path with an empty
   * segment that some collectors route and some 404.
   */
  it("does not double the separator when the base ends in a slash", () => {
    expect(signalEndpoint("http://collector:4318///", OTLP_SIGNAL_PATHS.metrics)).toBe(
      "http://collector:4318/v1/metrics",
    );
  });

  it("keeps a path prefix, for a collector behind a gateway", () => {
    expect(signalEndpoint("https://gw.example.test/otlp", OTLP_SIGNAL_PATHS.logs)).toBe(
      "https://gw.example.test/otlp/v1/logs",
    );
  });
});

describe("parseOtlpHeaders", () => {
  it("is empty for an unset or blank value", () => {
    expect(parseOtlpHeaders(undefined)).toEqual({});
    expect(parseOtlpHeaders("   ")).toEqual({});
  });

  it("reads a comma-separated list and trims around the separators", () => {
    expect(parseOtlpHeaders("api-key=abc, x-tenant = acme ")).toEqual({
      "api-key": "abc",
      "x-tenant": "acme",
    });
  });

  /**
   * The bug this function exists to not have. Base64 padding is `=`, so
   * splitting on every occurrence truncates a `Basic` credential to its first
   * segment and produces a header that authenticates nothing — a 401 from the
   * collector, in somebody else's logs.
   */
  it("splits on the first equals only, so a base64 credential survives", () => {
    expect(parseOtlpHeaders("authorization=Basic dXNlcjpwdw==")).toEqual({
      authorization: "Basic dXNlcjpwdw==",
    });
  });

  it("percent-decodes the value, as the specification's format requires", () => {
    expect(parseOtlpHeaders("x-note=a%20b%2Cc")).toEqual({ "x-note": "a b,c" });
  });

  it("refuses an entry that is not a pair rather than dropping it", () => {
    expect(() => parseOtlpHeaders("api-key=abc,nonsense")).toThrow(
      /OTEL_EXPORTER_OTLP_HEADERS entry "nonsense"/,
    );
    expect(() => parseOtlpHeaders("=value")).toThrow(/not a "key=value" pair/);
  });

  it("ignores a trailing comma, which is a typo and not a missing header", () => {
    expect(parseOtlpHeaders("api-key=abc,")).toEqual({ "api-key": "abc" });
  });
});

describe("telemetryOptionsFrom", () => {
  const parse = (env: Record<string, string>) => telemetryEnvSchema.parse(env);

  it("resolves the documented defaults from an empty environment", () => {
    const options = telemetryOptionsFrom(parse({}), "development");

    expect(options).toEqual({
      exporter: "none",
      serviceName: "boilerplate-nestjs-api",
      serviceVersion: null,
      environment: "development",
      otlpEndpoint: null,
      otlpHeaders: {},
      samplerRatio: 1,
      metricExportIntervalMs: 60_000,
      shutdownTimeoutMs: 5_000,
    });
  });

  /**
   * An endpoint left over from a previous configuration must not quietly turn
   * `console` into a second, unintended OTLP pipeline.
   */
  it("carries no endpoint unless the exporter is otlp", () => {
    const options = telemetryOptionsFrom(
      parse({ OTEL_EXPORTER: "console", OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector:4318" }),
      "development",
    );

    expect(options.otlpEndpoint).toBeNull();
  });

  it("passes the otlp endpoint and headers through", () => {
    const options = telemetryOptionsFrom(
      parse({
        OTEL_EXPORTER: "otlp",
        OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector:4318",
        OTEL_EXPORTER_OTLP_HEADERS: "api-key=mock-collector-token",
        OTEL_SERVICE_VERSION: "1.4.2",
        OTEL_TRACES_SAMPLER_ARG: "0.25",
      }),
      "production",
    );

    expect(options).toMatchObject({
      exporter: "otlp",
      otlpEndpoint: "http://collector:4318",
      otlpHeaders: { "api-key": "mock-collector-token" },
      serviceVersion: "1.4.2",
      samplerRatio: 0.25,
      environment: "production",
    });
  });
});
