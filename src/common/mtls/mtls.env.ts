import type { ConfigService } from "@nestjs/config";
import { z } from "zod";
import { isSerialisedOrigin } from "@/common/security/security.env";
import { ANY_PEER, isPeerIdentity, parseIdentityList } from "./peer-identity";

/**
 * The mutual-TLS half of the environment, as a shape rather than a schema.
 *
 * Spread into `envSchema` like `securityEnvShape` and `telemetryEnvShape`, and
 * read a second time straight from `process.env` by `main.ts` — because the TLS
 * options have to exist *before* `NestFactory.create`, which is before there is
 * a `ConfigService` to ask. That is the same bind `telemetry/register.ts` is in,
 * and it has the same answer: one declaration, parsed twice, so the two readings
 * cannot disagree about what a valid peer identity is.
 *
 * Everything here is off by default. A clean clone boots over plain HTTP, and
 * turning `MTLS_ENABLED` on without the three files is a refused boot rather
 * than a service that listens and fails every handshake.
 */
export const mtlsEnvShape = {
  /**
   * Whether this service terminates mutual TLS itself.
   *
   * Off by default, and off is the right setting for two common deployments:
   * a public API behind a load balancer that terminates TLS, and a mesh where
   * the sidecar does mTLS and hands the application plaintext on loopback. On
   * is for the third — the service that is its own TLS endpoint, which is what
   * `docs/mtls.md` describes and what the e2e suite exercises.
   *
   * Spelled as a union rather than `z.coerce.boolean()` for the reason
   * `CORS_ALLOW_CREDENTIALS` documents: coercion makes every non-empty string
   * true, so `MTLS_ENABLED=false` would enable it.
   */
  MTLS_ENABLED: z
    .union([z.boolean(), z.enum(["true", "false", "1", "0"])])
    .default(false)
    .transform((value) => value === true || value === "true" || value === "1"),

  /** PEM leaf certificate, optionally followed by its intermediates. */
  MTLS_CERT_FILE: z.string().optional(),
  /** PEM private key for the leaf. Mounted from a secret, never checked in. */
  MTLS_KEY_FILE: z.string().optional(),
  /**
   * PEM trust anchors. Both directions use this bundle: it is what a client
   * certificate is verified against, and what this service verifies its peers'
   * server certificates against.
   */
  MTLS_CA_FILE: z.string().optional(),
  /**
   * Passphrase for an encrypted private key.
   *
   * A credential. It belongs in the secret store beside `JWT_SECRET`, and it is
   * deliberately not a file path: a passphrase in a file next to the key it
   * decrypts protects nothing.
   */
  MTLS_KEY_PASSPHRASE: z.string().optional(),

  /**
   * How often the files are re-read, in milliseconds. `0` disables reloading.
   *
   * Polling rather than `fs.watch`, and five minutes rather than five seconds.
   * See `docs/mtls.md`: a Kubernetes secret update replaces a symlinked
   * directory rather than writing the file, so a watch on the path a mesh
   * mounts sees nothing — the inode it is watching is still there, still
   * holding the old certificate.
   */
  MTLS_RELOAD_INTERVAL_MS: z.coerce.number().int().nonnegative().default(300_000),

  /**
   * Warn this many days before the material expires.
   *
   * Two weeks. A mesh rotating hourly never reaches it; a certificate issued by
   * hand once a year is exactly the one that needs the notice, and two weeks is
   * enough to get a change through a review.
   */
  MTLS_EXPIRY_WARNING_DAYS: z.coerce.number().int().nonnegative().default(14),

  /**
   * Which peer identities may call this service: a comma-separated list of
   * SPIFFE ids or DNS names, or `*` for "anyone our CA vouches for".
   *
   * `*` is the default so that turning mTLS on with a private CA is one step,
   * and it is refused in production: a trust anchor answers "is this a real
   * workload", not "may this workload call me". The two questions come apart
   * the moment the CA issues a certificate to anything else — a batch job, a
   * developer's laptop, the next team's service — and with `*` every one of
   * those is authorised here.
   */
  MTLS_ALLOWED_CLIENTS: z.string().default(ANY_PEER),

  /**
   * Paths that may be reached without a client certificate, as a comma-
   * separated list of prefixes.
   *
   * Liveness and readiness probes come from the kubelet, which has no workload
   * identity and cannot be given one. `/metrics` is here for the same reason:
   * the scraper is infrastructure, not a peer. Both are already unauthenticated
   * — see `docs/security-headers.md` — so this exempts nothing that was
   * protected by anything else.
   *
   * Exempting a path is only half the story: see
   * {@link mtlsEnvShape.MTLS_ALLOW_UNAUTHENTICATED_PROBES}, because the TLS
   * layer refuses the connection before any path is known.
   */
  MTLS_EXEMPT_PREFIXES: z.string().default("/v1/health,/metrics"),

  /**
   * Accept connections that present no client certificate, and reject them at
   * the request level instead.
   *
   * This is a real weakening and it is opt-in for that reason. With it off (the
   * default) the TLS layer answers an unauthenticated connection with an alert
   * during the handshake, and the exempt prefixes above are unreachable — a
   * kubelet probe cannot complete a handshake, so the pod never goes ready.
   * With it on, the handshake completes, `socket.authorized` is false, and
   * {@link MtlsPeerGuard} refuses every request outside the exempt prefixes.
   *
   * The cost is that an unauthenticated peer can now reach the TLS stack, the
   * HTTP parser and the router before being refused. The benefit is a health
   * probe that works. Which one is right depends on whether anything but the
   * kubelet can reach the port.
   */
  MTLS_ALLOW_UNAUTHENTICATED_PROBES: z
    .union([z.boolean(), z.enum(["true", "false", "1", "0"])])
    .default(false)
    .transform((value) => value === true || value === "true" || value === "1"),

  /**
   * The peers this service calls over mutual TLS, as `origin=identity` pairs.
   *
   * ```
   * MTLS_PEERS=https://orders.internal:8443=spiffe://cluster.local/ns/prod/sa/orders
   * ```
   *
   * Outbound calls to a listed origin present this service's client certificate
   * and require the server's certificate to carry the identity named here.
   * Everything else — Stripe, Twilio, the push gateway — goes out over ordinary
   * TLS against the public trust store, because our private CA has nothing to
   * say about them.
   *
   * Empty by default, and refused unless `MTLS_ENABLED` is on: a peer list
   * without material to present is a set of calls that would silently go out
   * without a client certificate.
   */
  MTLS_PEERS: z.string().default(""),
} as const;

const mtlsEnvSchema = z.object(mtlsEnvShape);

/** The parsed mTLS settings, as the rest of the module receives them. */
export type MtlsEnv = z.infer<typeof mtlsEnvSchema>;

/**
 * Reads the mTLS settings back out of the validated configuration.
 *
 * A re-parse across a type boundary, not a second validation — the same
 * contract `securityEnvFrom` documents.
 */
export function mtlsEnvFrom(config: Pick<ConfigService, "get">): MtlsEnv {
  const raw = Object.fromEntries(Object.keys(mtlsEnvShape).map((key) => [key, config.get(key)]));
  return mtlsEnvSchema.parse(raw);
}

/**
 * Parses the mTLS settings straight from `process.env`, for `main.ts`.
 *
 * `NestFactory.create` takes the TLS options as an argument, so they must exist
 * before the application — and therefore before `ConfigService` — does. Reading
 * the same shape is what keeps this from becoming a second, laxer parse: the
 * values `envSchema` will refuse a moment later are refused here too, with the
 * same messages, and a cross-field rule added below applies to both callers.
 */
export function mtlsEnvFromProcess(env: NodeJS.ProcessEnv): MtlsEnv {
  const raw = Object.fromEntries(Object.keys(mtlsEnvShape).map((key) => [key, env[key]]));
  const parsed = mtlsEnvSchema.parse(raw);
  const issues = collectMtlsIssues(parsed, env.NODE_ENV);
  if (issues.length > 0) {
    throw new Error(`Invalid mTLS configuration:\n- ${issues.map(describeIssue).join("\n- ")}`);
  }
  return parsed;
}

/** The identities in `MTLS_ALLOWED_CLIENTS`. */
export function parseAllowedClients(env: MtlsEnv): string[] {
  return parseIdentityList(env.MTLS_ALLOWED_CLIENTS);
}

/** The path prefixes in `MTLS_EXEMPT_PREFIXES`. */
export function parseExemptPrefixes(env: MtlsEnv): string[] {
  return parseIdentityList(env.MTLS_EXEMPT_PREFIXES);
}

/**
 * `MTLS_PEERS` as a map from origin to the identity that origin must present.
 *
 * Keyed by origin rather than by host: a peer reached on two ports is two
 * workloads as often as it is one, and `new URL(url).origin` is what a caller
 * has in hand at request time.
 */
export function parsePeerMap(raw: string): Map<string, string> {
  const peers = new Map<string, string>();
  for (const entry of parseIdentityList(raw)) {
    const separator = entry.indexOf("=");
    if (separator === -1) continue;
    const origin = entry.slice(0, separator).trim();
    const identity = entry.slice(separator + 1).trim();
    if (origin.length === 0 || identity.length === 0) continue;
    peers.set(origin, identity);
  }
  return peers;
}

interface MtlsIssue {
  readonly path: string;
  readonly message: string;
}

/**
 * Cross-field checks for the mTLS settings.
 *
 * Collected rather than reported directly so that both callers — `envSchema`'s
 * `superRefine` and the pre-Nest parse in `mtlsEnvFromProcess` — apply exactly
 * the same rules. A rule that existed in only one of them would be a boot that
 * fails in one place and not the other, which is worse than either.
 */
export function collectMtlsIssues(env: MtlsEnv, nodeEnv: string | undefined): MtlsIssue[] {
  const issues: MtlsIssue[] = [];
  const peers = parsePeerMap(env.MTLS_PEERS);

  if (!env.MTLS_ENABLED) {
    if (peers.size > 0) {
      issues.push({
        path: "MTLS_PEERS",
        message:
          "MTLS_PEERS is set while MTLS_ENABLED is off. There is no client certificate to " +
          "present, so those calls would go out as ordinary TLS — authenticated in one " +
          "direction only, and indistinguishable from a working mTLS deployment until the " +
          "peer starts requiring a certificate.",
      });
    }
    return issues;
  }

  for (const key of ["MTLS_CERT_FILE", "MTLS_KEY_FILE", "MTLS_CA_FILE"] as const) {
    if (env[key] === undefined || env[key] === "") {
      issues.push({ path: key, message: `${key} is required when MTLS_ENABLED is on.` });
    }
  }

  const allowed = parseAllowedClients(env);
  if (allowed.length === 0) {
    issues.push({
      path: "MTLS_ALLOWED_CLIENTS",
      message:
        "MTLS_ALLOWED_CLIENTS is empty, which denies every peer. Set it to the identities " +
        `that may call this service, or to ${ANY_PEER} to accept anyone the CA vouches for.`,
    });
  }

  const wildcardClients = allowed.length === 1 && allowed[0] === ANY_PEER;
  for (const identity of wildcardClients ? [] : allowed) {
    if (isPeerIdentity(identity)) continue;
    issues.push({
      path: "MTLS_ALLOWED_CLIENTS",
      message:
        `MTLS_ALLOWED_CLIENTS entry ${JSON.stringify(identity)} is not a peer identity. An ` +
        `identity is a URI SAN (spiffe://cluster.local/ns/prod/sa/web) or a DNS SAN ` +
        `(web.internal) — there is no wildcard matching, so an entry like *.internal denies ` +
        `every peer rather than allowing a family of them.`,
    });
  }

  if (nodeEnv === "production" && wildcardClients) {
    issues.push({
      path: "MTLS_ALLOWED_CLIENTS",
      message:
        `MTLS_ALLOWED_CLIENTS=${ANY_PEER} is refused in production: it authorises every ` +
        "workload the CA has ever issued a certificate to — including the batch job, the " +
        "next team's service and anything else in the trust domain. Authentication is what " +
        "the anchor gives you; this list is the authorisation, and it has to name someone.",
    });
  }

  for (const prefix of parseExemptPrefixes(env)) {
    if (prefix.startsWith("/")) continue;
    issues.push({
      path: "MTLS_EXEMPT_PREFIXES",
      message:
        `MTLS_EXEMPT_PREFIXES entry ${JSON.stringify(prefix)} does not start with "/". The ` +
        `value is matched against the request path, which always does.`,
    });
  }

  if (env.MTLS_ALLOW_UNAUTHENTICATED_PROBES && parseExemptPrefixes(env).length === 0) {
    issues.push({
      path: "MTLS_ALLOW_UNAUTHENTICATED_PROBES",
      message:
        "MTLS_ALLOW_UNAUTHENTICATED_PROBES is on with no MTLS_EXEMPT_PREFIXES. That accepts " +
        "unauthenticated connections into the TLS stack, the HTTP parser and the router, and " +
        "then refuses every one of them — the weakening with none of the benefit.",
    });
  }

  if (env.MTLS_RELOAD_INTERVAL_MS > 0 && env.MTLS_RELOAD_INTERVAL_MS < 1_000) {
    issues.push({
      path: "MTLS_RELOAD_INTERVAL_MS",
      message:
        `MTLS_RELOAD_INTERVAL_MS=${env.MTLS_RELOAD_INTERVAL_MS} re-reads three files from ` +
        "disk more than once a second, for material that changes hourly at the very most. " +
        "Use 0 to disable reloading or a value of at least 1000.",
    });
  }

  for (const entry of parseIdentityList(env.MTLS_PEERS)) {
    if (entry.includes("=")) continue;
    issues.push({
      path: "MTLS_PEERS",
      message:
        `MTLS_PEERS entry ${JSON.stringify(entry)} has no "=". Each entry pairs an origin ` +
        `with the identity that origin must present: https://orders.internal=spiffe://...`,
    });
  }

  for (const [origin, identity] of peers) {
    if (!isSerialisedOrigin(origin)) {
      issues.push({
        path: "MTLS_PEERS",
        message:
          `MTLS_PEERS key ${JSON.stringify(origin)} is not an origin. Write ` +
          `scheme://host[:port] with no path and no trailing slash — that is what ` +
          `new URL(requestUrl).origin produces, and the lookup is an exact match against it.`,
      });
      continue;
    }

    if (!origin.startsWith("https://")) {
      issues.push({
        path: "MTLS_PEERS",
        message:
          `MTLS_PEERS key ${JSON.stringify(origin)} is not https. A client certificate is ` +
          `presented during a TLS handshake; over http there is no handshake to present it in.`,
      });
    }

    if (!isPeerIdentity(identity)) {
      issues.push({
        path: "MTLS_PEERS",
        message:
          `MTLS_PEERS value ${JSON.stringify(identity)} for ${origin} is not a peer identity. ` +
          `Name the SPIFFE id or DNS SAN the peer's server certificate carries.`,
      });
    }
  }

  return issues;
}

/**
 * Applies {@link collectMtlsIssues} through zod, for `envSchema`'s
 * `superRefine`.
 */
export function refineMtlsEnv(
  env: MtlsEnv,
  nodeEnv: string | undefined,
  ctx: z.RefinementCtx,
): void {
  for (const issue of collectMtlsIssues(env, nodeEnv)) {
    ctx.addIssue({ code: "custom", path: [issue.path], message: issue.message });
  }
}

function describeIssue(issue: MtlsIssue): string {
  return `${issue.path}: ${issue.message}`;
}
