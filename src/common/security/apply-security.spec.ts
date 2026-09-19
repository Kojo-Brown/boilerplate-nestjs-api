import type { INestApplication } from "@nestjs/common";
import type { CorsOptions } from "@nestjs/common/interfaces/external/cors-options.interface";
import type { Request, Response } from "express";
import { z } from "zod";
import { SWAGGER_PATH } from "@/common/swagger/setup-swagger";
import { applySecurity } from "./apply-security";
import { type SecurityEnv, securityEnvShape } from "./security.env";

type Middleware = (req: Request, res: Response, next: () => void) => void;

/**
 * An application that records what was bound to it, in order.
 *
 * `create-test-app.ts` covers what the middleware does over a real router. What
 * it cannot show is the *order* the two registrations happen in, which decides
 * whether a preflight `cors` answers by itself carries the security headers —
 * and which is invisible in a passing response either way.
 */
function recordingApp(): {
  app: INestApplication;
  middleware: Middleware[];
  cors: CorsOptions[];
  calls: string[];
} {
  const middleware: Middleware[] = [];
  const cors: CorsOptions[] = [];
  const calls: string[] = [];

  const app = {
    use: (handler: Middleware) => {
      calls.push("use");
      middleware.push(handler);
    },
    enableCors: (options: CorsOptions) => {
      calls.push("enableCors");
      cors.push(options);
    },
  } as unknown as INestApplication;

  return { app, middleware, cors, calls };
}

/** The `Content-Security-Policy` the bound middleware sets for `path`. */
function policyFor(middleware: Middleware, path: string): string | undefined {
  const headers = new Map<string, string>();
  const res = {
    setHeader: (name: string, value: string) => headers.set(name.toLowerCase(), String(value)),
    removeHeader: (name: string) => headers.delete(name.toLowerCase()),
    getHeader: (name: string) => headers.get(name.toLowerCase()),
  } as unknown as Response;

  let reached = false;
  middleware({ path } as Request, res, () => {
    reached = true;
  });

  expect(reached).toBe(true);
  return headers.get("content-security-policy");
}

const env: SecurityEnv = z.object(securityEnvShape).parse({
  ALLOWED_ORIGINS: "https://app.example.com",
});

describe("applySecurity", () => {
  it("binds the header middleware before CORS", () => {
    // A preflight is answered by `cors` itself — it ends the response rather
    // than calling `next()` — so anything registered after it never runs on one.
    const { app, calls } = recordingApp();

    applySecurity(app, env);

    expect(calls).toEqual(["use", "enableCors"]);
  });

  it("binds exactly one middleware, which chooses the policy per request", () => {
    const { app, middleware } = recordingApp();

    applySecurity(app, env);

    expect(middleware).toHaveLength(1);
    expect(policyFor(middleware[0]!, "/v1/users")).toContain("default-src 'none'");
    expect(policyFor(middleware[0]!, `/${SWAGGER_PATH}`)).toContain("default-src 'self'");
    expect(policyFor(middleware[0]!, `/${SWAGGER_PATH}/swagger-ui.css`)).toContain(
      "style-src 'self' 'unsafe-inline'",
    );
  });

  it("hands CORS the allowlist from the environment it was given", () => {
    const { app, cors } = recordingApp();

    applySecurity(app, env);

    expect(cors).toHaveLength(1);
    expect(cors[0]!.credentials).toBe(true);
    expect(cors[0]!.maxAge).toBe(600);
  });
});
