import type { ConfigService } from "@nestjs/config";
import { z } from "zod";
import { TENANT_ID_PATTERN } from "./tenant-context";

/** The header a tenant may be named in. Lower case, because Node lower-cases them. */
export const TENANT_HEADER = "x-tenant-id";

/**
 * The tenancy half of the environment, as a shape rather than a schema.
 *
 * Spread into `envSchema` the way `securityEnvShape` and `cryptoEnvShape` are.
 * Every value here decides which customer's rows a request may reach, so each one
 * is validated at boot rather than at the first query: a malformed
 * `TENANCY_DEFAULT_TENANT_ID` would otherwise boot happily and fail inside a
 * policy evaluation, where the error is a foreign-key violation on a table
 * nobody was looking at.
 */
export const tenancyEnvShape = {
  /**
   * The tenant a request belongs to when nothing else says.
   *
   * This is what makes a single-tenant deployment — the one a clean clone is —
   * work with no tenancy configuration at all: one row in `tenants`, every
   * request resolved to it, and the policies still doing their job. It is also
   * why there is no `TENANCY_ENABLED` flag to forget to turn on: a single tenant
   * is multi-tenancy with one tenant, and a feature that is switched off in
   * development is a feature nothing tests.
   *
   * `default` matches the row `20261002000000_add_multi_tenancy` inserts. A
   * deployment that changes this has to insert the matching row itself —
   * otherwise every write fails the foreign key, which is a far better failure
   * than rows landing under a tenant nobody provisioned.
   */
  TENANCY_DEFAULT_TENANT_ID: z.string().default("default"),

  /**
   * Whether `X-Tenant-Id` is honoured.
   *
   * On, because it is how a client of a single-deployment API, a test and a
   * `curl` select a tenant without DNS. Trusting a header to *name* a tenant is
   * not a privilege escalation: naming one is not being authorised for it —
   * authentication still has to succeed against that tenant's users, the access
   * token carries the tenant it was issued for and `TenantTokenGuard` refuses a
   * mismatch, and the policies refuse anything the token got past.
   *
   * Turn it off where tenancy is structural (a subdomain per tenant, a gateway
   * that rewrites the host) and a client-supplied header would only ever be a
   * mistake or an attempt.
   *
   * Spelled as a union rather than `z.coerce.boolean()` for the reason
   * `MTLS_ENABLED` documents — coercion makes every non-empty string true, so
   * `TENANCY_TRUST_HEADER=false` would turn it on — and the `z.boolean()` branch
   * is what lets `tenancyEnvFrom` read the value back: `ConfigModule` stores what
   * this schema *returned*, so the second parse is handed the boolean rather than
   * the string an operator wrote.
   */
  TENANCY_TRUST_HEADER: z
    .union([z.boolean(), z.enum(["true", "false", "1", "0"])])
    .default(true)
    .transform((value) => value === true || value === "true" || value === "1"),

  /**
   * The domain tenant subdomains hang off — `api.example.com`, so that
   * `acme.api.example.com` is tenant `acme`.
   *
   * Unset by default, which disables host-based resolution entirely. That is the
   * safe direction: with a base domain configured, the *first label of the host*
   * decides which customer's data a request sees, and a deployment reachable
   * under more hostnames than its operator thinks (a load-balancer DNS name, a
   * CNAME somebody added) would be resolving tenants from a string an attacker
   * can choose. Configure it only once the host is actually controlled.
   */
  TENANCY_BASE_DOMAIN: z.string().optional(),
} as const;

const tenancyEnvSchema = z.object(tenancyEnvShape);

/** The parsed tenancy settings, as the rest of the module receives them. */
export type TenancyEnv = z.infer<typeof tenancyEnvSchema>;

/**
 * Reads the tenancy settings back out of the validated configuration.
 *
 * The same arrangement, for the same reason, as `cryptoEnvFrom`: the defaults
 * live in one place, and `ConfigModule` has already run them through
 * `envSchema`.
 */
export function tenancyEnvFrom(config: Pick<ConfigService, "get">): TenancyEnv {
  const raw = Object.fromEntries(Object.keys(tenancyEnvShape).map((key) => [key, config.get(key)]));

  return tenancyEnvSchema.parse(raw);
}

/**
 * Cross-field checks for the tenancy settings, applied by `envSchema`'s
 * `superRefine`.
 *
 * `_nodeEnv` is taken and unused, like `refineCryptoEnv`'s: nothing here is
 * refused only in production. The one production-only rule tenancy has — that
 * the connection must not bypass row-level security — cannot be checked from the
 * environment, because the answer is in `pg_roles`. `RlsEnforcementService` makes
 * it at boot instead.
 */
export function refineTenancyEnv(
  env: TenancyEnv,
  _nodeEnv: string | undefined,
  ctx: z.RefinementCtx,
): void {
  if (!TENANT_ID_PATTERN.test(env.TENANCY_DEFAULT_TENANT_ID)) {
    ctx.addIssue({
      code: "custom",
      path: ["TENANCY_DEFAULT_TENANT_ID"],
      message:
        `TENANCY_DEFAULT_TENANT_ID must match ${String(TENANT_ID_PATTERN)} — lower-case, ` +
        `dash-separated, at most 63 characters, which is the CHECK constraint on tenants.id and ` +
        `the longest a DNS label may be. A value this rejects could not be stored, and a tenant ` +
        `whose slug cannot be a subdomain cannot be routed to.`,
    });
  }

  const baseDomain = env.TENANCY_BASE_DOMAIN;
  if (baseDomain !== undefined) {
    if (baseDomain !== baseDomain.toLowerCase() || baseDomain !== baseDomain.trim()) {
      ctx.addIssue({
        code: "custom",
        path: ["TENANCY_BASE_DOMAIN"],
        message:
          `TENANCY_BASE_DOMAIN must be lower-case with no surrounding whitespace (got ` +
          `"${baseDomain}"). A \`Host\` header is compared case-insensitively, so a mixed-case ` +
          `value here would match no request at all.`,
      });
    }
    if (baseDomain.length === 0 || baseDomain.startsWith(".") || baseDomain.endsWith(".")) {
      ctx.addIssue({
        code: "custom",
        path: ["TENANCY_BASE_DOMAIN"],
        message:
          `TENANCY_BASE_DOMAIN must be a hostname with no leading or trailing dot — ` +
          `"api.example.com", or "localhost" for a development machine where ` +
          `"acme.localhost" resolves. A leading dot would make the first label of every host a ` +
          `tenant id, including the empty one.`,
      });
    }
  }
}
