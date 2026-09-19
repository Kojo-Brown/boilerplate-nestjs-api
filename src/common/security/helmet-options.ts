import type { HelmetOptions } from "helmet";
import type { CspDirectives } from "./content-security-policy";
import type { SecurityEnv } from "./security.env";

/**
 * Builds helmet's configuration for one policy variant.
 *
 * `directives` is the only thing that differs between the API responses and the
 * Swagger UI page — see `content-security-policy.ts` — so everything else here
 * is decided once and applies to every response the service sends.
 *
 * Written out in full rather than layered on `useDefaults: true`. A default
 * that changes in a patch release of helmet would otherwise change the
 * behaviour of this service without appearing in any diff, and the headers a
 * security review asks about should be readable in the file that sets them.
 */
export function buildHelmetOptions(env: SecurityEnv, directives: CspDirectives): HelmetOptions {
  return {
    contentSecurityPolicy: {
      useDefaults: false,
      directives,
      reportOnly: env.CSP_REPORT_ONLY,
    },

    /**
     * HSTS. The header is ignored over plain HTTP — a browser only records it
     * from a response that arrived over TLS — so sending it in development
     * costs nothing, and *not* sending it in production is the mistake this
     * removes the opportunity for. Terminating TLS at a load balancer does not
     * change that: the header has to come from somewhere, and an origin that
     * sends it is one fewer thing to remember when the ingress is replaced.
     */
    strictTransportSecurity: {
      maxAge: env.HSTS_MAX_AGE_SECONDS,
      includeSubDomains: env.HSTS_INCLUDE_SUBDOMAINS,
      preload: env.HSTS_PRELOAD,
    },

    /**
     * `X-Content-Type-Options: nosniff`. The reason an attacker cannot turn a
     * JSON response containing user-supplied text into an HTML document by
     * guessing at a `Content-Type` — and the first half of the pair the
     * `sandbox` directive completes.
     */
    xContentTypeOptions: true,

    /** `X-Frame-Options: DENY`, alongside `frame-ancestors 'none'`. */
    xFrameOptions: { action: "deny" },

    /**
     * `Referrer-Policy: no-referrer`.
     *
     * API URLs are full of identifiers — `/v1/users/:id`, `/v1/orders/:id` —
     * and a `Referer` header leaks them to whatever a page navigates to next.
     * There is no navigation from a JSON response that needs one.
     */
    referrerPolicy: { policy: "no-referrer" },

    /**
     * `Cross-Origin-Resource-Policy: same-origin`, which blocks a *no-CORS*
     * embed — an `<img>` or `<script>` tag on another site pointed at this
     * API. It does not affect the cross-origin `fetch` calls the allowlist
     * governs: those are CORS requests, and CORS is what decides them.
     */
    crossOriginResourcePolicy: { policy: "same-origin" },

    /** `Cross-Origin-Opener-Policy: same-origin`: no shared window handle. */
    crossOriginOpenerPolicy: { policy: "same-origin" },

    /**
     * COEP stays off. It governs what a *document* may embed, which matters for
     * a page that wants cross-origin isolation and not for a JSON API — and
     * turning it on would break the Swagger UI page's ability to load anything
     * that does not opt in. Helmet's own default is off for the same reason.
     */
    crossOriginEmbedderPolicy: false,

    originAgentCluster: true,
    xDnsPrefetchControl: { allow: false },
    xDownloadOptions: true,
    xPermittedCrossDomainPolicies: { permittedPolicies: "none" },

    /**
     * Removes `X-Powered-By: Express`, which only ever helps somebody else.
     * `true` is the value that removes it — helmet's middleware here deletes a
     * header rather than adding one, so `false` would leave it in place.
     */
    xPoweredBy: true,

    /**
     * `X-XSS-Protection: 0`, which is what helmet's `true` sends and is not a
     * typo. The legacy auditor this header enabled was itself exploitable and
     * has been removed from every current browser; explicitly disabling it
     * stops an old one from re-introducing the bug.
     */
    xXssProtection: true,
  };
}
