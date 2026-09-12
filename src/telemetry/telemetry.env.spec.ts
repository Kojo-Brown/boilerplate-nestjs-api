import { envSchema } from "@/config/env.schema";
import { telemetryEnvSchema } from "./telemetry.env";

/**
 * The base environment `envSchema` needs before it will look at anything else.
 * Obviously fake, and only ever parsed.
 */
const BASE_ENV = {
  DATABASE_URL: "postgresql://user:pw@localhost:5432/db",
  JWT_SECRET: "0".repeat(32),
} as const;

describe("telemetryEnvSchema", () => {
  it("defaults to collecting nothing at all", () => {
    expect(telemetryEnvSchema.parse({}).OTEL_EXPORTER).toBe("none");
  });

  it("coerces the numeric settings out of their string environment values", () => {
    const env = telemetryEnvSchema.parse({
      OTEL_TRACES_SAMPLER_ARG: "0.1",
      OTEL_METRIC_EXPORT_INTERVAL_MS: "15000",
    });

    expect(env.OTEL_TRACES_SAMPLER_ARG).toBe(0.1);
    expect(env.OTEL_METRIC_EXPORT_INTERVAL_MS).toBe(15_000);
  });

  it("refuses a sampling ratio outside 0..1", () => {
    expect(() => telemetryEnvSchema.parse({ OTEL_TRACES_SAMPLER_ARG: "1.5" })).toThrow();
    expect(() => telemetryEnvSchema.parse({ OTEL_TRACES_SAMPLER_ARG: "-0.1" })).toThrow();
  });

  it("refuses otlp without an endpoint", () => {
    expect(() => telemetryEnvSchema.parse({ OTEL_EXPORTER: "otlp" })).toThrow(
      /OTEL_EXPORTER_OTLP_ENDPOINT is required/,
    );
  });

  it("refuses the console exporter in production", () => {
    expect(() =>
      telemetryEnvSchema.parse({ OTEL_EXPORTER: "console", NODE_ENV: "production" }),
    ).toThrow(/refused in production/);

    expect(
      telemetryEnvSchema.parse({ OTEL_EXPORTER: "console", NODE_ENV: "development" }).OTEL_EXPORTER,
    ).toBe("console");
  });
});

/**
 * The half that would rot silently.
 *
 * `register.ts` parses one schema and `ConfigModule` parses another, so a
 * setting added to the shape but not reaching `envSchema` — or a rule enforced
 * by one and not the other — is a deployment that boots happily with telemetry
 * configured differently from what the operator was told at boot.
 */
describe("envSchema (telemetry settings)", () => {
  it("applies the same defaults as the standalone schema", () => {
    const app = envSchema.parse(BASE_ENV);
    const standalone = telemetryEnvSchema.parse({});

    expect(app.OTEL_EXPORTER).toBe(standalone.OTEL_EXPORTER);
    expect(app.OTEL_SERVICE_NAME).toBe(standalone.OTEL_SERVICE_NAME);
    expect(app.OTEL_TRACES_SAMPLER_ARG).toBe(standalone.OTEL_TRACES_SAMPLER_ARG);
    expect(app.OTEL_METRIC_EXPORT_INTERVAL_MS).toBe(standalone.OTEL_METRIC_EXPORT_INTERVAL_MS);
    expect(app.OTEL_SHUTDOWN_TIMEOUT_MS).toBe(standalone.OTEL_SHUTDOWN_TIMEOUT_MS);
  });

  it("enforces the same cross-field rules", () => {
    expect(() => envSchema.parse({ ...BASE_ENV, OTEL_EXPORTER: "otlp" })).toThrow(
      /OTEL_EXPORTER_OTLP_ENDPOINT is required/,
    );
    expect(() =>
      envSchema.parse({ ...BASE_ENV, NODE_ENV: "production", OTEL_EXPORTER: "console" }),
    ).toThrow(/refused in production/);
  });
});
