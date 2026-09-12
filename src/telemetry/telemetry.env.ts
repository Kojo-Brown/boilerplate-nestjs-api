import { z } from "zod";

/**
 * Where the SDK sends what it collects.
 *
 * `none` is the default and it does not mean "collect and discard" — it means
 * nothing is installed at all. {@link startTelemetry} registers no provider, no
 * propagator and no instrumentation, so `trace.getTracer()` hands back the
 * API's built-in no-op and every span in this codebase costs an object that is
 * never allocated. A clean clone therefore boots with no collector, no network
 * egress and no measurable overhead, which is the same default
 * `STORAGE_ADAPTER`, `IDEMPOTENCY_STORE` and `DISTRIBUTED_LOCK` take.
 *
 * `console` writes spans, metrics and log records to stdout. It is for seeing
 * the shape of the data while developing and is refused in production below:
 * a span per request on stdout is a log volume nobody budgeted for.
 *
 * `otlp` is the real one — OTLP over HTTP/protobuf to a collector.
 */
export const OTEL_EXPORTERS = ["none", "console", "otlp"] as const;

export type OtelExporterName = (typeof OTEL_EXPORTERS)[number];

/**
 * The telemetry half of the environment, as a shape rather than a schema.
 *
 * Spread into `envSchema` so an operator gets the same boot-time validation as
 * every other setting, and parsed on its own by `telemetry/register.ts`, which
 * runs *before* Nest exists and so cannot ask `ConfigService` for anything. One
 * declaration used twice, rather than two that are free to disagree about what
 * a valid sampling ratio is.
 *
 * The names are the ones the OpenTelemetry specification defines
 * (`OTEL_SERVICE_NAME`, `OTEL_EXPORTER_OTLP_ENDPOINT`,
 * `OTEL_TRACES_SAMPLER_ARG`) wherever a standard name exists, because an
 * operator who has configured an OTel SDK before should not have to learn this
 * service's private vocabulary. The values are nevertheless read here and
 * passed to the exporters explicitly rather than left to the SDK's own env
 * parsing: a setting that is validated at boot and one that is picked up
 * silently from the environment behave very differently on the day somebody
 * mistypes it.
 */
export const telemetryEnvShape = {
  OTEL_EXPORTER: z.enum(OTEL_EXPORTERS).default("none"),

  /**
   * `service.name` on every span, metric and log record.
   *
   * The one resource attribute every backend groups by, and the reason it has
   * a default rather than being optional: an unset `service.name` makes the
   * SDK fall back to `unknown_service:node`, and two services that both forget
   * it are indistinguishable in the same trace.
   */
  OTEL_SERVICE_NAME: z.string().min(1).default("boilerplate-nestjs-api"),

  /**
   * `service.version`. Optional, and left off the resource entirely when
   * unset — an attribute that is absent is honest, where one defaulted to
   * `0.0.0` quietly makes every deploy look like the same build.
   *
   * Set it from the image tag or the commit sha in the deployment, not here.
   */
  OTEL_SERVICE_VERSION: z.string().min(1).optional(),

  /**
   * Base endpoint of the collector — `http://otel-collector:4318`, not
   * `.../v1/traces`.
   *
   * The specification defines this variable as the base that each signal's
   * path is appended to, and `signalEndpoint()` does that appending; passing a
   * per-signal URL here sends metrics to the traces endpoint, which a
   * collector answers with a 400 the SDK only logs.
   */
  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().url().optional(),

  /**
   * Extra headers on every OTLP request, in the specification's
   * `key=value,key=value` form. This is how a hosted collector is
   * authenticated, so **it is a credential**: it belongs in the secret store
   * next to `JWT_SECRET`, never in a checked-in `.env`.
   */
  OTEL_EXPORTER_OTLP_HEADERS: z.string().optional(),

  /**
   * The head-sampling probability for a trace this service *starts*, between 0
   * and 1.
   *
   * Head sampling, and the distinction matters: the decision is made on the
   * first span and travels in `traceparent`'s sampled flag, so every service
   * downstream keeps or drops the same trace. That is what makes a sampled
   * trace complete rather than a scatter of unrelated fragments.
   *
   * A request that arrives *with* a `traceparent` is not resampled at all —
   * see the parent-based sampler in `otel-sdk.ts`. This number only applies
   * where this service is the entry point.
   */
  OTEL_TRACES_SAMPLER_ARG: z.coerce.number().min(0).max(1).default(1),

  /**
   * How often metrics are pushed. 60s is the specification's own default and a
   * sensible one for a delta-temporality push pipeline: the exporter sends
   * accumulated counts, so a shorter interval buys resolution at a linear cost
   * in requests, and nothing here is a gauge that needs to be fresh.
   */
  OTEL_METRIC_EXPORT_INTERVAL_MS: z.coerce.number().int().positive().default(60_000),

  /**
   * How long shutdown waits for the last batch to leave.
   *
   * Bounded because it is inside the process's own shutdown budget
   * (`SHUTDOWN_TIMEOUT_MS` in `main.ts`): a collector that has stopped
   * answering must not be able to turn a rolling deploy into the force-exit
   * path, and losing the final few seconds of telemetry is a much smaller
   * problem than a pod that will not terminate.
   */
  OTEL_SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().positive().default(5_000),
} as const;

/** The telemetry settings, after defaults have been applied. */
export type TelemetryEnv = z.infer<z.ZodObject<typeof telemetryEnvShape>>;

/**
 * The cross-field rules, as a function rather than a `superRefine` call.
 *
 * Shared for the same reason {@link telemetryEnvShape} is: `envSchema` and
 * `telemetryEnvSchema` both validate these settings, and a rule that lived on
 * one of them would be a rule the other deployment path does not enforce.
 */
export function refineTelemetryEnv(
  env: TelemetryEnv,
  nodeEnv: string | undefined,
  ctx: z.RefinementCtx,
): void {
  if (env.OTEL_EXPORTER === "otlp" && !env.OTEL_EXPORTER_OTLP_ENDPOINT) {
    ctx.addIssue({
      code: "custom",
      path: ["OTEL_EXPORTER_OTLP_ENDPOINT"],
      message:
        "OTEL_EXPORTER_OTLP_ENDPOINT is required when OTEL_EXPORTER=otlp. Without it the " +
        "exporter falls back to http://localhost:4318 and every batch fails against a port " +
        "nothing is listening on — visible only on the SDK's own diagnostic channel.",
    });
  }

  /**
   * Refused for the same reason `STORAGE_ADAPTER=memory` is: it is the
   * development choice, and it does not fail loudly in production. A span per
   * request and a log record per log line, written to stdout, is a log volume
   * nobody sized the cluster for — and the telemetry is still not anywhere it
   * can be queried.
   */
  if (nodeEnv === "production" && env.OTEL_EXPORTER === "console") {
    ctx.addIssue({
      code: "custom",
      path: ["OTEL_EXPORTER"],
      message:
        "OTEL_EXPORTER=console is refused in production: it writes every span, metric and " +
        "log record to stdout, which multiplies the log volume without putting the data " +
        "anywhere it can be queried. Use `otlp` with a collector, or `none`.",
    });
  }
}

/**
 * The standalone schema, for the pre-Nest bootstrap in `register.ts`.
 *
 * Parses the whole of `process.env` and keeps only the keys it declares, which
 * is what a `z.object` does by default and exactly what is wanted here:
 * everything else in the environment is none of this file's business.
 *
 * `NODE_ENV` is declared here and *not* in {@link telemetryEnvShape}, because
 * the shape is spread into `envSchema`, which declares `NODE_ENV` itself — two
 * declarations of one key in a spread means one of them silently loses.
 */
export const telemetryEnvSchema = z
  .object({ ...telemetryEnvShape, NODE_ENV: z.string().default("development") })
  .superRefine((env, ctx) => refineTelemetryEnv(env, env.NODE_ENV, ctx));
