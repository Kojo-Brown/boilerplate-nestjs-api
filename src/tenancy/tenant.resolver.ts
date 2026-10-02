import { BadRequestException } from "@nestjs/common";
import { isTenantId, TENANT_ID_PATTERN } from "./tenant-context";
import { TENANT_HEADER } from "./tenancy.env";
import type { TenancyEnv } from "./tenancy.env";
import type { TenantContext } from "./tenant-context";

/** Everything resolution reads off a request. Not `Request`, so this stays testable and pure. */
export interface TenantRequestHeaders {
  readonly host?: string | undefined;
  readonly [TENANT_HEADER]?: string | string[] | undefined;
}

/**
 * Decides which tenant a request belongs to, from the request alone.
 *
 * Deliberately synchronous and database-free, which is the reason `tenants.id` is
 * a slug rather than a surrogate key. The alternative — look the tenant up, cache
 * it, invalidate the cache — puts a round trip, a cache and a staleness window on
 * the path that decides which customer's data a request may see. It also puts a
 * *failure mode* there: a tenant whose lookup is slow or down would make the
 * question "whose data is this" unanswerable, and a resolver that cannot answer
 * either rejects a legitimate request or guesses.
 *
 * Nothing here asserts that the tenant exists. That check is the foreign key on
 * `users.tenantId` and the policies: an unknown tenant reads nothing and cannot
 * write, which is the same answer a lookup would have produced, arrived at
 * without a lookup.
 */
export function resolveTenant(headers: TenantRequestHeaders, env: TenancyEnv): TenantContext {
  const fromHost = tenantFromHost(headers.host, env.TENANCY_BASE_DOMAIN);
  const fromHeader = env.TENANCY_TRUST_HEADER
    ? tenantFromHeader(headers[TENANT_HEADER])
    : undefined;

  // Disagreement is refused rather than resolved by precedence. The two sources
  // mean different things — the host is what DNS and the ingress decided, the
  // header is what the client asked for — and a request where they disagree is
  // either a misconfigured gateway or somebody probing for which one wins. There
  // is no answer that is right often enough to be worth guessing.
  if (fromHost !== undefined && fromHeader !== undefined && fromHost !== fromHeader) {
    throw new BadRequestException(
      `The host names tenant "${fromHost}" and the ${TENANT_HEADER} header names ` +
        `"${fromHeader}". Send one or the other, or make them agree.`,
    );
  }

  const resolved = fromHost ?? fromHeader;
  if (resolved !== undefined) {
    return { tenantId: resolved, source: fromHost !== undefined ? "host" : "header" };
  }

  return { tenantId: env.TENANCY_DEFAULT_TENANT_ID, source: "default" };
}

/**
 * The first label of the host, when the rest of it is the configured base domain.
 *
 * `acme.api.example.com` under `api.example.com` is `acme`; `api.example.com`
 * itself is nobody, and so is `acme.evil.example.com`. The port is stripped
 * because `Host` carries one whenever the listener is not on 80 or 443, and an
 * IPv6 literal (`[::1]:4000`) is not a tenant and must not be read as one.
 *
 * A label that is not a valid tenant id — `www`, an uppercase label, something
 * with an underscore — resolves to nobody rather than to a rejection: a
 * deployment behind a base domain still has to serve the apex and whatever else
 * points at it, and those requests belong to the default tenant.
 */
function tenantFromHost(
  host: string | undefined,
  baseDomain: string | undefined,
): string | undefined {
  if (host === undefined || baseDomain === undefined) return undefined;

  const hostname = stripPort(host).toLowerCase();
  const suffix = `.${baseDomain}`;
  if (!hostname.endsWith(suffix)) return undefined;

  const label = hostname.slice(0, -suffix.length);
  // One label only: `a.b.api.example.com` is not tenant `a.b`, because a tenant
  // id cannot contain a dot — and reading it as one would let anybody who can
  // add a CNAME invent tenants.
  if (label.includes(".") || !isTenantId(label)) return undefined;

  return label;
}

/**
 * The tenant named by the header, or a rejection if it is malformed.
 *
 * Unlike the host, a header is an explicit claim: a client that sends
 * `X-Tenant-Id: Acme Corp` has asked for something this system cannot mean, and
 * answering as the default tenant would silently serve it the wrong data. A
 * repeated header is refused for the same reason — Node joins duplicates into an
 * array, and picking one of them is a guess.
 */
function tenantFromHeader(value: string | string[] | undefined): string | undefined {
  if (value === undefined) return undefined;

  if (Array.isArray(value)) {
    throw new BadRequestException(
      `The ${TENANT_HEADER} header was sent ${value.length} times. Send it once.`,
    );
  }

  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  if (!isTenantId(trimmed)) {
    throw new BadRequestException(
      `"${trimmed}" is not a tenant id: it has to match ${String(TENANT_ID_PATTERN)}.`,
    );
  }

  return trimmed;
}

/** `example.com:4000` → `example.com`, leaving an IPv6 literal intact. */
function stripPort(host: string): string {
  if (host.startsWith("[")) return host.slice(0, host.indexOf("]") + 1);
  const colon = host.lastIndexOf(":");
  return colon === -1 ? host : host.slice(0, colon);
}
