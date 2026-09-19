import type { ConfigService } from "@nestjs/config";
import { z } from "zod";

/**
 * The HTTP-security half of the environment, as a shape rather than a schema.
 *
 * Spread into `envSchema` the same way `telemetryEnvShape` is, so an operator
 * gets the same boot-time validation here as everywhere else — and so a
 * misconfigured allowlist or an HSTS header that can never be accepted for
 * preload is a refused boot rather than something a browser discovers later.
 *
 * Everything in here is a header. That is the whole reason these settings are
 * worth validating so aggressively: a wrong value produces no error anywhere in
 * this process. The request succeeds, the response is correct, and the only
 * party that notices is a browser in somebody else's tab, which silently drops
 * the response and reports it to a console nobody is reading.
 */
export const securityEnvShape = {
  /**
   * The CORS allowlist: a comma-separated list of origins, or `*`.
   *
   * An origin is `scheme://host[:port]` and nothing else — no path, no trailing
   * slash, no `*.example.com` wildcard. {@link refineSecurityEnv} enforces that
   * at boot because the `Origin` header a browser sends is in exactly that
   * form, and a comparison against `https://app.example.com/` fails for every
   * request forever while looking completely reasonable in a `.env` file.
   *
   * `*` means "reflect whatever origin asks", which is the default so that a
   * clean clone boots with no CORS configuration at all — and which is refused
   * in production below whenever credentials are also enabled, since the two
   * together hand every site on the internet an authenticated session.
   */
  ALLOWED_ORIGINS: z.string().default("*"),

  /**
   * Whether cross-origin requests may carry cookies and `Authorization`.
   *
   * On by default: this API issues a refresh token and expects a browser SPA on
   * another origin to send it. Turn it off for a genuinely public, read-only
   * deployment — that is the only configuration in which `ALLOWED_ORIGINS=*` is
   * a defensible production setting.
   *
   * Spelled as a union rather than `z.coerce.boolean()` for the reason
   * `OUTBOX_RELAY_ENABLED` documents: coercion makes every non-empty string
   * true, so `CORS_ALLOW_CREDENTIALS=false` would *enable* credentials.
   */
  CORS_ALLOW_CREDENTIALS: z
    .union([z.boolean(), z.enum(["true", "false", "1", "0"])])
    .default(true)
    .transform((value) => value === true || value === "true" || value === "1"),

  /**
   * `Access-Control-Max-Age`: how long a browser may cache a preflight.
   *
   * Ten minutes. Chromium caps this at 2 hours and Firefox at 24, so a larger
   * number is not wrong so much as ignored; ten minutes keeps a preflight off
   * the wire for every burst of requests while still letting an allowlist
   * change take effect in a coffee break rather than a working day.
   */
  CORS_MAX_AGE_SECONDS: z.coerce.number().int().nonnegative().default(600),

  /**
   * `Strict-Transport-Security: max-age`.
   *
   * Two years, which is what the preload list asks for. The number is a promise
   * about the future — every browser that has seen this header refuses to talk
   * to this host over cleartext for that long, whatever the DNS says — so it is
   * lowered deliberately rather than by accident, and {@link refineSecurityEnv}
   * refuses a value that contradicts `HSTS_PRELOAD`.
   */
  HSTS_MAX_AGE_SECONDS: z.coerce.number().int().nonnegative().default(63_072_000),

  /** `includeSubDomains`. Required for preload; see {@link refineSecurityEnv}. */
  HSTS_INCLUDE_SUBDOMAINS: z
    .union([z.boolean(), z.enum(["true", "false", "1", "0"])])
    .default(true)
    .transform((value) => value === true || value === "true" || value === "1"),

  /**
   * `preload`, the token that makes this host eligible for the browser-shipped
   * HSTS preload list.
   *
   * Sending it is a submission, not a request: hstspreload.org reads the header
   * and only accepts a host whose `max-age` is at least 31536000 and which also
   * sends `includeSubDomains`. Getting *off* the list takes months, so the
   * combination is checked at boot rather than discovered at submission.
   */
  HSTS_PRELOAD: z
    .union([z.boolean(), z.enum(["true", "false", "1", "0"])])
    .default(true)
    .transform((value) => value === true || value === "true" || value === "1"),

  /**
   * Where a browser posts a CSP violation, via `report-uri`.
   *
   * Optional and unset by default: a directive naming a collector that does not
   * exist is a failed request per violation, per visitor.
   */
  CSP_REPORT_URI: z.string().url().optional(),

  /**
   * Send `Content-Security-Policy-Report-Only` instead of the enforcing header.
   *
   * For the one job report-only is good at: measuring what a policy *would*
   * have blocked before it blocks it. Off by default, because a policy that is
   * only ever observed is not a control.
   */
  CSP_REPORT_ONLY: z
    .union([z.boolean(), z.enum(["true", "false", "1", "0"])])
    .default(false)
    .transform((value) => value === true || value === "true" || value === "1"),
} as const;

const securityEnvSchema = z.object(securityEnvShape);

/** The parsed security settings, as the rest of the module receives them. */
export type SecurityEnv = z.infer<typeof securityEnvSchema>;

/**
 * Reads the security settings back out of the validated configuration.
 *
 * `ConfigModule.forRoot({ validate })` stores what `envSchema` returned, so the
 * values here are already coerced and already refined — the re-parse is a type
 * boundary, not a second validation, and is idempotent for exactly that reason.
 *
 * Going through `ConfigService` rather than reading `process.env` again is the
 * point: `ConfigModule` is what decides which `.env` file was loaded and which
 * variables it was allowed to expand, and a bootstrap that parsed the raw
 * environment a second time would be configuring the middleware from a
 * different source than the one the application validated.
 */
export function securityEnvFrom(config: Pick<ConfigService, "get">): SecurityEnv {
  const raw = Object.fromEntries(
    Object.keys(securityEnvShape).map((key) => [key, config.get(key)]),
  );

  return securityEnvSchema.parse(raw);
}

/** The shortest `max-age` the HSTS preload list will accept, in seconds. */
export const HSTS_PRELOAD_MIN_MAX_AGE_SECONDS = 31_536_000;

/**
 * Every entry of `ALLOWED_ORIGINS` that is not the `*` wildcard, trimmed and
 * with empties dropped.
 *
 * Exported because both the refinement below and {@link buildCorsOptions} have
 * to agree on what "the list" is, down to the whitespace — a split that
 * disagreed with the one that validated it would validate one list and enforce
 * another.
 */
export function parseOriginList(raw: string): string[] {
  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/** Whether `ALLOWED_ORIGINS` is the reflect-anything wildcard. */
export function isWildcardOriginList(raw: string): boolean {
  const entries = parseOriginList(raw);
  return entries.length === 1 && entries[0] === "*";
}

/**
 * Whether `value` is a serialised origin in the form a browser actually sends.
 *
 * The grammar is deliberately narrower than `URL`'s: `new URL()` happily parses
 * `https://app.example.com/callback` and `https://*.example.com`, and both of
 * those are the mistakes this function exists to catch.
 */
export function isSerialisedOrigin(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }

  // `origin` is `null` for a scheme the URL standard calls opaque (`file:`,
  // `data:`), and those can never match an allowlist entry.
  if (url.origin === "null") return false;

  // `*` is not a forbidden host code point, so `https://*.example.com` parses
  // cleanly and survives the round trip below as an ordinary host. It has to be
  // rejected by name: CORS has no wildcard-subdomain syntax, so an allowlist
  // written that way is not too permissive — it matches nothing at all, which
  // is the harder mistake to spot from the outside.
  if (url.hostname.includes("*")) return false;

  // The round trip is the check. `URL` normalises as it parses — it drops a
  // default port, lowercases the host, and appends the `/` path that makes
  // `https://app.example.com/` and `https://app.example.com` parse alike — so
  // comparing the input against `url.origin` rejects exactly the inputs that
  // are not already in the form the `Origin` header carries.
  return value === url.origin;
}

/**
 * Cross-field checks for the security settings.
 *
 * Kept next to the shape, and applied by `envSchema`'s `superRefine`, so the
 * rules travel with the variables they are about.
 */
export function refineSecurityEnv(
  env: SecurityEnv,
  nodeEnv: string | undefined,
  ctx: z.RefinementCtx,
): void {
  const wildcard = isWildcardOriginList(env.ALLOWED_ORIGINS);

  if (!wildcard) {
    for (const origin of parseOriginList(env.ALLOWED_ORIGINS)) {
      if (isSerialisedOrigin(origin)) continue;

      ctx.addIssue({
        code: "custom",
        path: ["ALLOWED_ORIGINS"],
        message:
          `ALLOWED_ORIGINS entry ${JSON.stringify(origin)} is not an origin. An origin is ` +
          `scheme://host[:port] with no path, no trailing slash and no wildcard — a browser ` +
          `sends "https://app.example.com" in the Origin header and never ` +
          `"https://app.example.com/", so an entry in any other form matches nothing, for ` +
          `every request, without logging anything here.`,
      });
    }
  }

  /**
   * `*` plus credentials is the one CORS misconfiguration that is worth
   * refusing a deployment over. It is not merely permissive — it is the
   * property every browser's same-origin policy exists to deny: any page on the
   * internet may call this API with the visitor's cookies attached and read the
   * response.
   *
   * It is refused rather than downgraded because the safe downgrade (drop the
   * credentials) would break every authenticated browser client, and the other
   * one (drop the wildcard) means guessing which origins were meant.
   *
   * Outside production `*` stays usable, which is what lets a clean clone boot
   * with no configuration and what `test/helpers/setup-env.ts` relies on.
   */
  if (nodeEnv === "production" && wildcard && env.CORS_ALLOW_CREDENTIALS) {
    ctx.addIssue({
      code: "custom",
      path: ["ALLOWED_ORIGINS"],
      message:
        "ALLOWED_ORIGINS=* is refused in production while CORS_ALLOW_CREDENTIALS is on: " +
        "reflecting any origin on a credentialed API lets any site a user visits call it " +
        "with their session and read the response. List the origins your clients are served " +
        "from, or set CORS_ALLOW_CREDENTIALS=false if this deployment is genuinely public.",
    });
  }

  if (env.HSTS_PRELOAD && env.HSTS_MAX_AGE_SECONDS < HSTS_PRELOAD_MIN_MAX_AGE_SECONDS) {
    ctx.addIssue({
      code: "custom",
      path: ["HSTS_MAX_AGE_SECONDS"],
      message:
        `HSTS_MAX_AGE_SECONDS (${env.HSTS_MAX_AGE_SECONDS}) is below the ` +
        `${HSTS_PRELOAD_MIN_MAX_AGE_SECONDS} the HSTS preload list requires, so the preload ` +
        `token being sent alongside it is inert: the submission at hstspreload.org is ` +
        `rejected and the header reads as a promise nobody will honour. Raise the max-age or ` +
        `set HSTS_PRELOAD=false.`,
    });
  }

  if (env.HSTS_PRELOAD && !env.HSTS_INCLUDE_SUBDOMAINS) {
    ctx.addIssue({
      code: "custom",
      path: ["HSTS_INCLUDE_SUBDOMAINS"],
      message:
        "HSTS_PRELOAD requires HSTS_INCLUDE_SUBDOMAINS: the preload list does not accept a " +
        "host that protects itself and leaves its subdomains reachable over cleartext, " +
        "because a subdomain is where a cookie-stealing downgrade actually happens. Enable " +
        "includeSubDomains once every subdomain is on HTTPS, or set HSTS_PRELOAD=false.",
    });
  }
}
