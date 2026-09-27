import { z } from "zod";
import { isPermittedOperatorPattern } from "./redaction-allowlist";

/**
 * The redaction half of the environment.
 *
 * A shape spread into `envSchema`, following `telemetryEnvShape` and
 * `securityEnvShape`, so an operator gets one boot-time validation for
 * everything rather than a setting that is checked and a setting that is picked
 * up silently.
 */
export const loggingEnvShape = {
  /**
   * Whether the redaction processors are installed.
   *
   * Defaults to **on**, which is the opposite of every optional backend in this
   * codebase and deliberately so. `STORAGE_ADAPTER`, `IDEMPOTENCY_STORE` and
   * `OTEL_EXPORTER` all default to the inert choice because a clean clone
   * should boot with nothing configured; those are capabilities. This is a
   * control, and a control that has to be switched on protects the deployments
   * that read the documentation. The reason to turn it off is to see an
   * unredacted line while developing, and that is what development is for.
   *
   * It is **refused in production** below, for the same reason
   * `OTEL_EXPORTER=console` and a credentialed `ALLOWED_ORIGINS=*` are: it is
   * the setting whose consequence is invisible from inside the process and
   * expensive outside it. The supported way to log a field in production is to
   * name it in `LOG_REDACTION_EXTRA_ALLOWLIST`, which is a decision in a diff
   * rather than a blanket.
   *
   * The union rather than `z.coerce.boolean()`, for the reason the other
   * booleans here spell out: `Boolean("false")` is `true`, so the one spelling
   * an operator reaches for to turn something off would turn it on — which, on
   * this setting, would be the good direction by luck rather than by design.
   */
  LOG_REDACTION_ENABLED: z
    .union([z.boolean(), z.enum(["true", "false", "1", "0"])])
    .default(true)
    .transform((value) => value === true || value === "true" || value === "1"),

  /**
   * Extra field paths to log in the clear, comma-separated —
   * `order.currency,query.region`.
   *
   * Exists so that adding a field to a log line is a configuration change in
   * front of an operator rather than a code change behind a deploy, which is
   * what makes an allowlist survivable in practice: the alternative is a team
   * that cannot see a field they need until the next release and turns the
   * whole mechanism off instead.
   *
   * Each entry is validated as a path pattern at boot — a malformed one is
   * refused rather than dropped, because an allowlist entry that was silently
   * discarded is a field an operator believes is being logged and which is not
   * there on the day they look. A pattern beginning `*` is refused too: see
   * {@link isPermittedOperatorPattern}.
   */
  LOG_REDACTION_EXTRA_ALLOWLIST: z.string().optional(),
} as const;

export type LoggingEnv = z.infer<z.ZodObject<typeof loggingEnvShape>>;

/** Splits the operator's list. Empty entries are tolerated; trailing commas happen. */
export function parseExtraAllowlist(raw: string | undefined): readonly string[] {
  if (raw === undefined) return [];
  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/**
 * The cross-field rules, shared for the reason `refineTelemetryEnv` is.
 */
export function refineLoggingEnv(
  env: LoggingEnv,
  nodeEnv: string | undefined,
  ctx: z.RefinementCtx,
): void {
  if (nodeEnv === "production" && !env.LOG_REDACTION_ENABLED) {
    ctx.addIssue({
      code: "custom",
      path: ["LOG_REDACTION_ENABLED"],
      message:
        "LOG_REDACTION_ENABLED=false is refused in production: it writes every field of every " +
        "log record — request bodies, query strings, OAuth authorisation codes — to stdout and " +
        "to the logs pipeline, where they are retained for as long as the log store keeps " +
        "anything and cannot be recalled. To log a specific field deliberately, name it in " +
        "LOG_REDACTION_EXTRA_ALLOWLIST instead. See docs/log-redaction.md.",
    });
  }

  for (const pattern of parseExtraAllowlist(env.LOG_REDACTION_EXTRA_ALLOWLIST)) {
    if (isPermittedOperatorPattern(pattern)) continue;
    ctx.addIssue({
      code: "custom",
      path: ["LOG_REDACTION_EXTRA_ALLOWLIST"],
      message:
        `"${pattern}" is not a usable allowlist entry. Entries are dot-separated field ` +
        "paths — `order.currency`, `items[].sku`, `counts.*` — and may not begin with `*`, " +
        "which would admit every top-level field and disable redaction while looking like " +
        "configuration. See docs/log-redaction.md.",
    });
  }
}

/**
 * The standalone schema, for the logger's own construction.
 *
 * `TelemetryLogger` is installed in `main.ts` *before* `app.get(ConfigService)`
 * is reached, and it has to be: `bufferLogs: true` replays the whole boot
 * sequence through whatever logger is installed, and those lines — a
 * configuration summary, a connection string a driver complained about — are as
 * much in need of redaction as anything logged later. Asking the container for
 * settings the container does not yet have would mean the boot lines were the
 * one part of the log that went out in the clear.
 *
 * So the same two keys are read twice, exactly as `telemetryEnvSchema` is read
 * twice and for the same reason. `envSchema` remains the authority — a
 * malformed value still fails the boot with a message naming it — and this is
 * the copy the logger can reach.
 */
export const loggingEnvSchema = z
  .object({ ...loggingEnvShape, NODE_ENV: z.string().default("development") })
  .superRefine((env, ctx) => refineLoggingEnv(env, env.NODE_ENV, ctx));

/**
 * The settings, or the safe ones if the environment does not parse.
 *
 * Fails **closed**: an environment this cannot read produces full redaction, not
 * none. The alternative is a typo in `LOG_REDACTION_ENABLED` disabling the
 * control, which is precisely backwards — and it would be invisible, because
 * `envSchema` is about to refuse the same environment and the operator would be
 * reading that error rather than watching the logs. Throwing from here instead
 * would replace that clear message with a stack trace out of a logger
 * constructor.
 */
export function readLoggingEnv(source: NodeJS.ProcessEnv = process.env): LoggingEnv {
  const parsed = loggingEnvSchema.safeParse(source);
  if (parsed.success) return parsed.data;
  return { LOG_REDACTION_ENABLED: true, LOG_REDACTION_EXTRA_ALLOWLIST: undefined };
}
