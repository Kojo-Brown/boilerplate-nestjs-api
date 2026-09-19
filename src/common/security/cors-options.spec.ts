import type {
  CorsOptions,
  CustomOrigin,
} from "@nestjs/common/interfaces/external/cors-options.interface";
import { z } from "zod";
import {
  CORS_ALLOWED_HEADERS,
  CORS_EXPOSED_HEADERS,
  CORS_METHODS,
  buildCorsOptions,
} from "./cors-options";
import { type SecurityEnv, securityEnvShape } from "./security.env";

const parseEnv = (overrides: Record<string, unknown> = {}): SecurityEnv =>
  z.object(securityEnvShape).parse(overrides);

/**
 * Asks the configured origin function what it would answer for `requestOrigin`.
 *
 * Returns what `cors` would put in `Access-Control-Allow-Origin`: the origin
 * string when it is reflected, `true` when the request is waved through with no
 * origin at all, and `false` when the header is withheld.
 */
function decide(options: CorsOptions, requestOrigin: string | undefined): unknown {
  const origin = options.origin as CustomOrigin;
  let decision: unknown;
  let error: Error | null = null;

  origin(requestOrigin, (err, allowed) => {
    error = err;
    decision = allowed;
  });

  expect(error).toBeNull();
  return decision;
}

describe("buildCorsOptions — allowlist", () => {
  const env = parseEnv({ ALLOWED_ORIGINS: "https://app.example.com,https://admin.example.com" });
  const options = buildCorsOptions(env);

  it("reflects an origin that is on the list", () => {
    // Reflected rather than echoed as a list: `Access-Control-Allow-Origin`
    // takes a single origin, and a browser handed two values honours neither.
    expect(decide(options, "https://app.example.com")).toBe("https://app.example.com");
    expect(decide(options, "https://admin.example.com")).toBe("https://admin.example.com");
  });

  it("withholds the header for an origin that is not", () => {
    expect(decide(options, "https://evil.example.com")).toBe(false);
  });

  it("does not accept a subdomain of an allowed origin", () => {
    // `https://app.example.com` does not imply `https://x.app.example.com`, and
    // a subdomain is exactly what an attacker who has found a dangling DNS
    // record controls.
    expect(decide(options, "https://x.app.example.com")).toBe(false);
  });

  it("does not accept the same host on another scheme or port", () => {
    expect(decide(options, "http://app.example.com")).toBe(false);
    expect(decide(options, "https://app.example.com:8443")).toBe(false);
  });

  it("allows a request that carries no Origin at all", () => {
    // curl, a health probe, a server-to-server call. CORS is a browser
    // mechanism; refusing these would break every non-browser client while
    // stopping nothing, since anything that can omit the header can also forge
    // it outside a browser.
    expect(decide(options, undefined)).toBe(true);
  });

  it("never hands the callback an error, whatever the origin", () => {
    // An `Error` here becomes a 500 through `AllExceptionsFilter`: a page in a
    // stranger's tab could fill this service's logs and alerting with traffic
    // it chose, and the browser blocks the response either way.
    const origin = options.origin as CustomOrigin;
    const errors: (Error | null)[] = [];

    for (const candidate of ["https://evil.example.com", "not-an-origin", ""]) {
      origin(candidate, (err) => errors.push(err));
    }

    expect(errors).toEqual([null, null, null]);
  });
});

describe("buildCorsOptions — wildcard", () => {
  const options = buildCorsOptions(parseEnv({ ALLOWED_ORIGINS: "*" }));

  it("reflects the caller's origin rather than answering `*`", () => {
    // With credentials on, a literal `*` is rejected by the browser rather than
    // honoured — the response is discarded and the fetch fails. Reflection is
    // the only spelling of "any origin" that a credentialed request can use.
    expect(decide(options, "https://anywhere.example.com")).toBe("https://anywhere.example.com");
  });

  it("still allows a request with no Origin", () => {
    expect(decide(options, undefined)).toBe(true);
  });
});

describe("buildCorsOptions — headers and caching", () => {
  const options = buildCorsOptions(parseEnv({ ALLOWED_ORIGINS: "https://app.example.com" }));

  it("allows the request headers this API actually reads", () => {
    // A preflight is refused outright if it names a header missing from this
    // list, so each entry is a feature a browser client can use at all.
    expect(options.allowedHeaders).toEqual([...CORS_ALLOWED_HEADERS]);
    expect(options.allowedHeaders).toEqual(
      expect.arrayContaining(["Authorization", "If-Match", "idempotency-key"]),
    );
  });

  it("exposes the response headers a client has to read to use the API", () => {
    // Omitting one of these breaks nothing at the network level: the header
    // arrives and `headers.get(...)` returns null. A client would conclude this
    // API has no ETags and could never send the `If-Match` the write path
    // requires.
    expect(options.exposedHeaders).toEqual([...CORS_EXPOSED_HEADERS]);
    expect(options.exposedHeaders).toEqual(
      expect.arrayContaining(["ETag", "Idempotency-Replayed", "Retry-After"]),
    );
  });

  it("routes the methods the API serves, PATCH included", () => {
    expect(options.methods).toEqual([...CORS_METHODS]);
    expect(options.methods).toContain("PATCH");
  });

  it("carries the credential and cache settings from the environment", () => {
    expect(options.credentials).toBe(true);
    expect(options.maxAge).toBe(600);
    // A preflight with a body would be wrapped by `ResponseEnvelopeInterceptor`
    // into JSON for a request that asked for nothing.
    expect(options.optionsSuccessStatus).toBe(204);
  });

  it("turns credentials off when the environment does", () => {
    const publicApi = buildCorsOptions(parseEnv({ CORS_ALLOW_CREDENTIALS: "false" }));

    expect(publicApi.credentials).toBe(false);
  });
});
