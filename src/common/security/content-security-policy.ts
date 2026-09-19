import { SWAGGER_PATH } from "@/common/swagger/setup-swagger";
import type { SecurityEnv } from "./security.env";

/**
 * A CSP as helmet takes it: directive name to token list, `[]` for a directive
 * that takes no value.
 */
export type CspDirectives = Record<string, string[]>;

/**
 * The policy every API response carries.
 *
 * `default-src 'none'` is the whole point. A JSON API has no legitimate
 * subresources, so the correct policy is not a careful allowlist but a refusal:
 * nothing loads, nothing executes, nothing connects. That matters on exactly
 * one kind of day — when a browser has been persuaded to render a response as
 * HTML, whether through a sniffing bug, a `Content-Type` this service got
 * wrong, or a reflected value in an error body. `X-Content-Type-Options:
 * nosniff` is the first answer to that and this is the second, because defences
 * against script execution should not have a single point of failure.
 *
 * `frame-ancestors 'none'` is the modern `X-Frame-Options: DENY` — helmet sends
 * both, and the frame-ancestors directive is the one that is actually honoured
 * where the two disagree.
 *
 * `sandbox` drops the response into an opaque origin with scripts, forms and
 * plugins disabled. On a JSON body it changes nothing a client can observe; on
 * the day the paragraph above describes, it is the difference between an
 * injected `<script>` running with this origin's cookies and not running.
 */
export const API_CSP_DIRECTIVES: Readonly<CspDirectives> = Object.freeze({
  "default-src": ["'none'"],
  "base-uri": ["'none'"],
  "form-action": ["'none'"],
  "frame-ancestors": ["'none'"],
  sandbox: [],
});

/**
 * The policy the Swagger UI page carries.
 *
 * Separate from {@link API_CSP_DIRECTIVES} because `default-src 'none'` would
 * leave `/docs` a blank page: it is a real HTML document that loads a
 * stylesheet, three scripts and a favicon. Loosening the API policy to
 * accommodate it would be the wrong trade in the obvious direction — every JSON
 * response in the service would carry a policy written for one page of
 * developer documentation.
 *
 * `'self'` throughout: `@nestjs/swagger` serves `swagger-ui-dist` from this
 * origin, so nothing here reaches a CDN and no third-party host needs naming.
 * `connect-src 'self'` is what lets **Try it out** call this API and nothing
 * else — a document that is allowed to script should not also be allowed to
 * post what it reads somewhere.
 *
 * `'unsafe-inline'` appears once, on `style-src`, and it is not there by
 * oversight: the page `@nestjs/swagger` generates carries two inline `<style>`
 * blocks, and Swagger UI writes more at runtime. Hashes cannot cover the
 * runtime ones. It is confined to styles — `script-src` stays `'self'`, which
 * is the directive that decides whether injected markup can execute.
 */
export const DOCS_CSP_DIRECTIVES: Readonly<CspDirectives> = Object.freeze({
  "default-src": ["'self'"],
  "base-uri": ["'self'"],
  "script-src": ["'self'"],
  "style-src": ["'self'", "'unsafe-inline'"],
  "img-src": ["'self'", "data:"],
  "font-src": ["'self'", "data:"],
  "connect-src": ["'self'"],
  "form-action": ["'self'"],
  "frame-ancestors": ["'none'"],
  "object-src": ["'none'"],
});

/**
 * Whether a request path is the Swagger UI document or one of its assets.
 *
 * `/docs-json` and `/docs-yaml` — which `SwaggerModule.setup` also mounts — are
 * deliberately *not* docs paths. They are API responses that happen to live
 * next to the page, and they get the API policy like every other one.
 */
export function isDocsPath(path: string): boolean {
  return path === `/${SWAGGER_PATH}` || path.startsWith(`/${SWAGGER_PATH}/`);
}

/**
 * The base directives with `report-uri` appended when a collector is
 * configured.
 *
 * `report-uri` rather than the newer `report-to`: `report-to` needs a matching
 * `Reporting-Endpoints` header and is still unimplemented in Safari and
 * Firefox, so a policy that used it alone would report nothing from most of the
 * browsers a violation is likely to come from.
 */
export function withReportUri(base: Readonly<CspDirectives>, env: SecurityEnv): CspDirectives {
  const directives: CspDirectives = Object.fromEntries(
    Object.entries(base).map(([name, tokens]) => [name, [...tokens]]),
  );

  if (env.CSP_REPORT_URI !== undefined) {
    directives["report-uri"] = [env.CSP_REPORT_URI];
  }

  return directives;
}

/** The complete policy a response on `path` should carry. */
export function cspDirectivesFor(path: string, env: SecurityEnv): CspDirectives {
  return withReportUri(isDocsPath(path) ? DOCS_CSP_DIRECTIVES : API_CSP_DIRECTIVES, env);
}
