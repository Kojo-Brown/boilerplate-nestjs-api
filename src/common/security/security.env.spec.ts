import { z } from "zod";
import {
  HSTS_PRELOAD_MIN_MAX_AGE_SECONDS,
  isSerialisedOrigin,
  isWildcardOriginList,
  parseOriginList,
  refineSecurityEnv,
  securityEnvFrom,
  securityEnvShape,
} from "./security.env";

/**
 * The security shape on its own, refined exactly as `envSchema` refines it.
 *
 * A local schema rather than the real one so a failing expectation names the
 * rule under test instead of every unrelated variable a full environment would
 * also have to satisfy. `env.schema.spec.ts` covers the wiring itself.
 */
const schema = z
  .object(securityEnvShape)
  .superRefine((env, ctx) => refineSecurityEnv(env, nodeEnv, ctx));

let nodeEnv: string | undefined = "test";

beforeEach(() => {
  nodeEnv = "test";
});

describe("parseOriginList", () => {
  it("splits on commas and forgives the whitespace an operator types", () => {
    expect(parseOriginList("https://a.example.com, https://b.example.com")).toEqual([
      "https://a.example.com",
      "https://b.example.com",
    ]);
  });

  it("drops empty entries rather than producing an origin that matches nothing", () => {
    // A trailing comma is the most common way to write this list, and an empty
    // string in the allowlist would be an entry no `Origin` header can equal.
    expect(parseOriginList("https://a.example.com,,")).toEqual(["https://a.example.com"]);
  });
});

describe("isWildcardOriginList", () => {
  it("recognises the bare wildcard", () => {
    expect(isWildcardOriginList("*")).toBe(true);
    expect(isWildcardOriginList(" * ")).toBe(true);
  });

  it("does not treat a wildcard mixed into a list as a wildcard", () => {
    // `*, https://app.example.com` reads like "these and anything else"; it is
    // treated as a two-entry allowlist, so the `*` is refused as a malformed
    // origin rather than silently opening the API.
    expect(isWildcardOriginList("*,https://app.example.com")).toBe(false);
  });
});

describe("isSerialisedOrigin", () => {
  it.each(["https://app.example.com", "http://localhost:3000", "https://app.example.com:8443"])(
    "accepts %s",
    (value) => {
      expect(isSerialisedOrigin(value)).toBe(true);
    },
  );

  it.each([
    // The trailing slash: what `new URL(...).href` gives back, and what an
    // operator copies out of a browser address bar. Never equal to an `Origin`.
    ["https://app.example.com/", "a trailing slash"],
    ["https://app.example.com/callback", "a path"],
    ["https://*.example.com", "a wildcard subdomain"],
    ["app.example.com", "no scheme"],
    ["https://app.example.com?x=1", "a query string"],
    // The default port is dropped by the browser when it serialises an origin.
    ["https://app.example.com:443", "an explicit default port"],
    ["file:///etc/hosts", "an opaque origin"],
    ["", "an empty string"],
  ])("rejects %s (%s)", (value) => {
    expect(isSerialisedOrigin(value)).toBe(false);
  });
});

describe("refineSecurityEnv", () => {
  const base = { ALLOWED_ORIGINS: "https://app.example.com" };

  it("accepts a plain allowlist", () => {
    expect(() => schema.parse(base)).not.toThrow();
  });

  it("names the malformed entry rather than the whole list", () => {
    expect(
      () => schema.parse({ ALLOWED_ORIGINS: "https://a.example.com,https://b.example.com/" }),
      // The quotes come back escaped: Zod stringifies the whole issue list into
      // the error message.
    ).toThrow(/entry \\"https:\/\/b\.example\.com\/\\" is not an origin/);
  });

  it("allows the wildcard outside production, which is what a clean clone boots on", () => {
    expect(() => schema.parse({ ALLOWED_ORIGINS: "*" })).not.toThrow();
  });

  it("refuses a credentialed wildcard in production", () => {
    nodeEnv = "production";

    expect(() => schema.parse({ ALLOWED_ORIGINS: "*" })).toThrow(
      /ALLOWED_ORIGINS=\* is refused in production/,
    );
  });

  it("allows the wildcard in production once credentials are off", () => {
    // A genuinely public, unauthenticated API is a real deployment; it is the
    // combination with credentials that is indefensible, not the wildcard.
    nodeEnv = "production";

    expect(() =>
      schema.parse({ ALLOWED_ORIGINS: "*", CORS_ALLOW_CREDENTIALS: "false" }),
    ).not.toThrow();
  });

  it("refuses a preload promise the preload list would reject", () => {
    expect(() =>
      schema.parse({ ...base, HSTS_MAX_AGE_SECONDS: String(HSTS_PRELOAD_MIN_MAX_AGE_SECONDS - 1) }),
    ).toThrow(/below the 31536000 the HSTS preload list requires/);
  });

  it("refuses preload without includeSubDomains", () => {
    expect(() => schema.parse({ ...base, HSTS_INCLUDE_SUBDOMAINS: "false" })).toThrow(
      /HSTS_PRELOAD requires HSTS_INCLUDE_SUBDOMAINS/,
    );
  });

  it("allows a short max-age once preload is off", () => {
    const env = schema.parse({ ...base, HSTS_PRELOAD: "false", HSTS_MAX_AGE_SECONDS: "300" });

    expect(env.HSTS_MAX_AGE_SECONDS).toBe(300);
    expect(env.HSTS_PRELOAD).toBe(false);
  });
});

describe("securityEnvShape defaults", () => {
  it("boots with no security configuration at all", () => {
    const env = schema.parse({});

    expect(env.ALLOWED_ORIGINS).toBe("*");
    expect(env.CORS_ALLOW_CREDENTIALS).toBe(true);
    expect(env.CORS_MAX_AGE_SECONDS).toBe(600);
    expect(env.HSTS_MAX_AGE_SECONDS).toBe(63_072_000);
    expect(env.HSTS_INCLUDE_SUBDOMAINS).toBe(true);
    expect(env.HSTS_PRELOAD).toBe(true);
    expect(env.CSP_REPORT_URI).toBeUndefined();
    expect(env.CSP_REPORT_ONLY).toBe(false);
  });

  it.each(["false", "0"])("reads %s as off rather than as a non-empty string", (value) => {
    // The trap `OUTBOX_RELAY_ENABLED` documents: `z.coerce.boolean()` makes
    // every non-empty string true, so the one spelling whose whole purpose is
    // to turn something off would turn it on.
    expect(schema.parse({ CSP_REPORT_ONLY: value }).CSP_REPORT_ONLY).toBe(false);
  });

  it("rejects a boolean spelling it cannot be sure about", () => {
    expect(() => schema.parse({ HSTS_PRELOAD: "no" })).toThrow();
  });

  it("rejects a report collector that is not a URL", () => {
    expect(() => schema.parse({ CSP_REPORT_URI: "/csp-reports" })).toThrow();
  });
});

describe("securityEnvFrom", () => {
  it("reads the settings back out of an already-validated configuration", () => {
    // `ConfigModule` stores what `envSchema` returned, so the values arriving
    // here are already coerced — booleans as booleans, numbers as numbers. The
    // re-parse has to be idempotent over them, not just over raw strings.
    const stored: Record<string, unknown> = {
      ALLOWED_ORIGINS: "https://app.example.com",
      CORS_ALLOW_CREDENTIALS: true,
      CORS_MAX_AGE_SECONDS: 600,
      HSTS_MAX_AGE_SECONDS: 63_072_000,
      HSTS_INCLUDE_SUBDOMAINS: true,
      HSTS_PRELOAD: true,
      CSP_REPORT_ONLY: false,
    };

    const env = securityEnvFrom({ get: <T>(key: string) => stored[key] as T });

    expect(env).toEqual({ ...stored, CSP_REPORT_URI: undefined });
  });

  it("falls back to the declared defaults for anything the configuration lacks", () => {
    const env = securityEnvFrom({ get: () => undefined });

    expect(env.ALLOWED_ORIGINS).toBe("*");
    expect(env.HSTS_PRELOAD).toBe(true);
  });
});
