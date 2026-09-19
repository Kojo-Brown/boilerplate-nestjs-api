import type { INestApplication } from "@nestjs/common";
import type { NextFunction, Request, Response } from "express";
import helmet from "helmet";
import {
  API_CSP_DIRECTIVES,
  DOCS_CSP_DIRECTIVES,
  isDocsPath,
  withReportUri,
} from "./content-security-policy";
import { buildCorsOptions } from "./cors-options";
import { buildHelmetOptions } from "./helmet-options";
import type { SecurityEnv } from "./security.env";

/**
 * Binds the response-header middleware and the CORS allowlist.
 *
 * Called by `main.ts` and by `test/helpers/create-test-app.ts`, for the reason
 * the interceptor ordering in both is shared: an e2e suite that bound these
 * differently would be testing an application nobody deploys — and these are
 * headers, so the suite is the only place their absence is ever noticed.
 *
 * It must run before `app.init()`. Express middleware is matched in
 * registration order, and Nest mounts its router during `init()`; anything
 * added afterwards sits behind every route and never runs.
 */
export function applySecurity(app: INestApplication, env: SecurityEnv): void {
  const apiHeaders = helmet(buildHelmetOptions(env, withReportUri(API_CSP_DIRECTIVES, env)));
  const docsHeaders = helmet(buildHelmetOptions(env, withReportUri(DOCS_CSP_DIRECTIVES, env)));

  // Two policies, one middleware. Helmet has no path matching of its own and
  // Nest's `MiddlewareConsumer` cannot reach the Swagger routes — they are
  // mounted by `SwaggerModule.setup` directly on the Express instance, outside
  // any module — so the branch is here, on the request path, where both are
  // visible.
  app.use((req: Request, res: Response, next: NextFunction) => {
    const headers = isDocsPath(req.path) ? docsHeaders : apiHeaders;
    headers(req, res, next);
  });

  // After the header middleware, so a preflight that `cors` answers itself —
  // it ends the response rather than calling `next()` — still carries the
  // security headers everything else does.
  app.enableCors(buildCorsOptions(env));
}
