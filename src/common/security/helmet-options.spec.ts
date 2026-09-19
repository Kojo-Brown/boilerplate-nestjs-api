import type { IncomingMessage, ServerResponse } from "http";
import helmet from "helmet";
import { z } from "zod";
import { API_CSP_DIRECTIVES, DOCS_CSP_DIRECTIVES } from "./content-security-policy";
import { buildHelmetOptions } from "./helmet-options";
import { type SecurityEnv, securityEnvShape } from "./security.env";

const parseEnv = (overrides: Record<string, unknown> = {}): SecurityEnv =>
  z.object(securityEnvShape).parse(overrides);

/**
 * Runs the middleware the options produce and returns the headers it set.
 *
 * Asserting on the options object would test that this file says what it says.
 * The only question worth answering is what helmet *does* with it — which is
 * how `xPoweredBy: true` meaning "remove the header" and `xXssProtection: true`
 * meaning "send `0`" get verified rather than assumed.
 */
function headersFrom(env: SecurityEnv, directives = API_CSP_DIRECTIVES): Record<string, string> {
  const sent = new Map<string, string>();
  // Present before helmet runs, exactly as Express sets it, so the middleware
  // that removes it has something to remove.
  sent.set("x-powered-by", "Express");

  const res = {
    setHeader: (name: string, value: string | number) =>
      sent.set(name.toLowerCase(), String(value)),
    removeHeader: (name: string) => sent.delete(name.toLowerCase()),
    getHeader: (name: string) => sent.get(name.toLowerCase()),
  } as unknown as ServerResponse;

  let called = false;
  helmet(buildHelmetOptions(env, { ...directives }))(
    {} as IncomingMessage,
    res,
    (err?: unknown) => {
      expect(err).toBeUndefined();
      called = true;
    },
  );

  expect(called).toBe(true);
  return Object.fromEntries(sent);
}

describe("buildHelmetOptions — Content-Security-Policy", () => {
  it("sends the API policy as the enforcing header", () => {
    const headers = headersFrom(parseEnv());

    expect(headers["content-security-policy"]).toBe(
      "default-src 'none';base-uri 'none';form-action 'none';frame-ancestors 'none';sandbox",
    );
    expect(headers["content-security-policy-report-only"]).toBeUndefined();
  });

  it("sends the docs policy when handed the docs directives", () => {
    const headers = headersFrom(parseEnv(), DOCS_CSP_DIRECTIVES);

    expect(headers["content-security-policy"]).toContain("script-src 'self'");
    expect(headers["content-security-policy"]).toContain("style-src 'self' 'unsafe-inline'");
  });

  it("switches to the report-only header when asked, and only then", () => {
    // Report-only measures what a policy would have blocked. It is off by
    // default because a policy that is only ever observed is not a control.
    const headers = headersFrom(parseEnv({ CSP_REPORT_ONLY: "true" }));

    expect(headers["content-security-policy-report-only"]).toContain("default-src 'none'");
    expect(headers["content-security-policy"]).toBeUndefined();
  });

  it("carries only the directives it was given, with none of helmet's defaults", () => {
    // `useDefaults: false`. Helmet's default policy includes `script-src
    // 'self'` and `upgrade-insecure-requests`, and inheriting them would mean a
    // helmet patch release could change this service's policy without
    // appearing in any diff.
    const policy = headersFrom(parseEnv())["content-security-policy"] ?? "";

    expect(policy).not.toContain("script-src");
    expect(policy).not.toContain("upgrade-insecure-requests");
  });
});

describe("buildHelmetOptions — Strict-Transport-Security", () => {
  it("sends a two-year preload-eligible policy by default", () => {
    expect(headersFrom(parseEnv())["strict-transport-security"]).toBe(
      "max-age=63072000; includeSubDomains; preload",
    );
  });

  it("drops the preload token when the environment does", () => {
    const headers = headersFrom(parseEnv({ HSTS_PRELOAD: "false", HSTS_MAX_AGE_SECONDS: "300" }));

    expect(headers["strict-transport-security"]).toBe("max-age=300; includeSubDomains");
  });
});

describe("buildHelmetOptions — the rest of the headers", () => {
  const headers = headersFrom(parseEnv());

  it("stops content sniffing and framing", () => {
    expect(headers["x-content-type-options"]).toBe("nosniff");
    expect(headers["x-frame-options"]).toBe("DENY");
  });

  it("leaks no URLs through Referer", () => {
    // `/v1/users/:id` and `/v1/orders/:id` are identifiers, and a JSON response
    // has no navigation that needs a referrer.
    expect(headers["referrer-policy"]).toBe("no-referrer");
  });

  it("refuses a no-CORS embed and a shared window handle", () => {
    expect(headers["cross-origin-resource-policy"]).toBe("same-origin");
    expect(headers["cross-origin-opener-policy"]).toBe("same-origin");
  });

  it("leaves Cross-Origin-Embedder-Policy alone", () => {
    // It governs what a document may embed, which is not a question a JSON API
    // has, and turning it on would stop the Swagger UI page loading anything
    // that has not opted in.
    expect(headers["cross-origin-embedder-policy"]).toBeUndefined();
  });

  it("removes X-Powered-By rather than leaving Express's fingerprint on it", () => {
    expect(headers["x-powered-by"]).toBeUndefined();
  });

  it("disables the legacy XSS auditor instead of enabling it", () => {
    // `X-XSS-Protection: 0`, which is what helmet's `true` sends and is not a
    // typo: the auditor was itself exploitable and is gone from every current
    // browser.
    expect(headers["x-xss-protection"]).toBe("0");
  });

  it("sets the remaining hardening headers", () => {
    expect(headers["origin-agent-cluster"]).toBe("?1");
    expect(headers["x-dns-prefetch-control"]).toBe("off");
    expect(headers["x-download-options"]).toBe("noopen");
    expect(headers["x-permitted-cross-domain-policies"]).toBe("none");
  });
});
