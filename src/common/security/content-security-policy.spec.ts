import { z } from "zod";
import { SWAGGER_PATH } from "@/common/swagger/setup-swagger";
import {
  API_CSP_DIRECTIVES,
  DOCS_CSP_DIRECTIVES,
  cspDirectivesFor,
  isDocsPath,
  withReportUri,
} from "./content-security-policy";
import { type SecurityEnv, securityEnvShape } from "./security.env";

const parseEnv = (overrides: Record<string, unknown> = {}): SecurityEnv =>
  z.object(securityEnvShape).parse(overrides);

describe("isDocsPath", () => {
  it("matches the Swagger UI page and its assets", () => {
    expect(isDocsPath(`/${SWAGGER_PATH}`)).toBe(true);
    expect(isDocsPath(`/${SWAGGER_PATH}/`)).toBe(true);
    expect(isDocsPath(`/${SWAGGER_PATH}/swagger-ui-bundle.js`)).toBe(true);
  });

  it("does not match the OpenAPI documents served next to it", () => {
    // `/docs-json` and `/docs-yaml` are API responses, not a document a browser
    // renders, so they take the strict policy like everything else.
    expect(isDocsPath(`/${SWAGGER_PATH}-json`)).toBe(false);
    expect(isDocsPath(`/${SWAGGER_PATH}-yaml`)).toBe(false);
  });

  it("does not match a route that merely starts with the same letters", () => {
    expect(isDocsPath("/v1/users")).toBe(false);
    expect(isDocsPath(`/v1/${SWAGGER_PATH}`)).toBe(false);
    expect(isDocsPath(`/${SWAGGER_PATH}uments`)).toBe(false);
  });
});

describe("API policy", () => {
  const directives = cspDirectivesFor("/v1/users", parseEnv());

  it("forbids every kind of subresource", () => {
    // A JSON API has no legitimate subresources at all, so the policy is a
    // refusal rather than an allowlist. This is the second answer to a response
    // being rendered as HTML; `nosniff` is the first.
    expect(directives["default-src"]).toEqual(["'none'"]);
  });

  it("cannot be framed, and cannot be used to submit a form or rewrite a base URL", () => {
    expect(directives["frame-ancestors"]).toEqual(["'none'"]);
    expect(directives["form-action"]).toEqual(["'none'"]);
    expect(directives["base-uri"]).toEqual(["'none'"]);
  });

  it("sandboxes the response", () => {
    // A directive with no value, which is the most restrictive form: an opaque
    // origin with scripts, forms and plugins disabled.
    expect(directives["sandbox"]).toEqual([]);
  });

  it("names no script source, not even 'self'", () => {
    expect(directives["script-src"]).toBeUndefined();
  });
});

describe("docs policy", () => {
  const directives = cspDirectivesFor(`/${SWAGGER_PATH}`, parseEnv());

  it("loads its own assets and nothing from anywhere else", () => {
    // `swagger-ui-dist` is served from this origin by `@nestjs/swagger`, so no
    // CDN needs naming and `'self'` is the whole allowlist.
    expect(directives["default-src"]).toEqual(["'self'"]);
    expect(directives["connect-src"]).toEqual(["'self'"]);
  });

  it("allows inline styles but not inline scripts", () => {
    // The page `@nestjs/swagger` generates carries two inline `<style>` blocks
    // and Swagger UI writes more at runtime, which no hash can cover. The
    // concession is confined to styling: `script-src` stays `'self'`, and that
    // is the directive that decides whether injected markup executes.
    expect(directives["style-src"]).toEqual(["'self'", "'unsafe-inline'"]);
    expect(directives["script-src"]).toEqual(["'self'"]);
    expect(directives["script-src"]).not.toContain("'unsafe-inline'");
  });

  it("still refuses framing and plugin content", () => {
    expect(directives["frame-ancestors"]).toEqual(["'none'"]);
    expect(directives["object-src"]).toEqual(["'none'"]);
  });
});

describe("withReportUri", () => {
  it("adds nothing when no collector is configured", () => {
    // A `report-uri` naming a collector that does not exist is a failed request
    // per violation, per visitor.
    expect(cspDirectivesFor("/v1/users", parseEnv())["report-uri"]).toBeUndefined();
  });

  it("appends the configured collector to whichever policy applies", () => {
    const env = parseEnv({ CSP_REPORT_URI: "https://csp.example.com/report" });

    expect(cspDirectivesFor("/v1/users", env)["report-uri"]).toEqual([
      "https://csp.example.com/report",
    ]);
    expect(cspDirectivesFor(`/${SWAGGER_PATH}`, env)["report-uri"]).toEqual([
      "https://csp.example.com/report",
    ]);
  });

  it("does not mutate the shared directive tables", () => {
    // Both policies are module-level constants reused for every request; a
    // builder that appended to them in place would accumulate a `report-uri`
    // per call and leak the docs policy's tokens into the API one.
    withReportUri(API_CSP_DIRECTIVES, parseEnv({ CSP_REPORT_URI: "https://csp.example.com/r" }));

    expect(API_CSP_DIRECTIVES["report-uri"]).toBeUndefined();
    expect(API_CSP_DIRECTIVES["default-src"]).toEqual(["'none'"]);
    expect(DOCS_CSP_DIRECTIVES["default-src"]).toEqual(["'self'"]);
  });
});
