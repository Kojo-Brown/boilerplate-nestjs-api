import { Controller, Get, type INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { z } from "zod";
import request from "supertest";
import { applySecurity, type SecurityEnv, securityEnvShape } from "@/common/security";
import { SWAGGER_PATH, setupSwagger } from "@/common/swagger/setup-swagger";
import { createTestApp } from "./helpers/create-test-app";

const ALLOWED = "https://app.example.com";
const DENIED = "https://evil.example.com";

@Controller("ping")
class PingController {
  @Get()
  ping(): { ok: true } {
    return { ok: true };
  }
}

/**
 * Builds a minimal application with one route, the security middleware, and
 * nothing else.
 *
 * `createTestApp` boots the real application, but it boots it on the
 * environment `setup-env.ts` froze at import time — `ALLOWED_ORIGINS=*` — and
 * `ConfigModule` validates that environment while `app.module.ts` is being
 * imported, so no `beforeAll` can change it. A second, smaller app is how a
 * *named* allowlist gets exercised over a real router at all; the suite below
 * covers the real application with what it is actually configured with.
 */
async function createSecuredApp(
  overrides: Record<string, unknown>,
  configure: (app: INestApplication) => void = () => {},
): Promise<INestApplication> {
  const env: SecurityEnv = z.object(securityEnvShape).parse(overrides);
  const moduleRef = await Test.createTestingModule({ controllers: [PingController] }).compile();
  const app = moduleRef.createNestApplication();

  applySecurity(app, env);
  configure(app);
  await app.init();
  return app;
}

describe("Security headers and CORS (e2e)", () => {
  describe("on the real application", () => {
    let app: INestApplication;

    beforeAll(async () => {
      ({ app } = await createTestApp());
    });

    afterAll(async () => {
      await app.close();
    });

    it("hardens an ordinary API response", async () => {
      // No status assertion: `/v1/health` is served here against
      // `InMemoryPrismaService`, which reports the database it does not have as
      // down. What the headers must not depend on is exactly that — whether the
      // handler was happy.
      const response = await request(app.getHttpServer()).get("/v1/health");

      expect(response.headers["content-security-policy"]).toBe(
        "default-src 'none';base-uri 'none';form-action 'none';frame-ancestors 'none';sandbox",
      );
      expect(response.headers["strict-transport-security"]).toBe(
        "max-age=63072000; includeSubDomains; preload",
      );
      expect(response.headers["x-content-type-options"]).toBe("nosniff");
      expect(response.headers["x-frame-options"]).toBe("DENY");
      expect(response.headers["referrer-policy"]).toBe("no-referrer");
      expect(response.headers["cross-origin-resource-policy"]).toBe("same-origin");
      expect(response.headers["x-powered-by"]).toBeUndefined();
    });

    it("hardens an error response too", async () => {
      // The headers are bound as middleware rather than as an interceptor
      // precisely so that a response produced by `AllExceptionsFilter` — or by
      // no handler at all — carries them. A reflected value in an error body is
      // one of the ways a response gets rendered as HTML in the first place.
      const response = await request(app.getHttpServer()).get("/v1/nothing-here").expect(404);

      expect(response.headers["content-security-policy"]).toContain("default-src 'none'");
      expect(response.headers["x-content-type-options"]).toBe("nosniff");
    });

    it("reflects the caller's origin under the wildcard the test environment uses", async () => {
      // `ALLOWED_ORIGINS=*` with credentials on. Reflected rather than `*`,
      // because a browser discards a credentialed response that answers `*`.
      const response = await request(app.getHttpServer()).get("/v1/health").set("Origin", DENIED);

      expect(response.headers["access-control-allow-origin"]).toBe(DENIED);
      expect(response.headers["access-control-allow-origin"]).not.toBe("*");
      expect(response.headers["access-control-allow-credentials"]).toBe("true");
    });
  });

  describe("with a named allowlist", () => {
    let app: INestApplication;

    beforeAll(async () => {
      app = await createSecuredApp({ ALLOWED_ORIGINS: `${ALLOWED},https://admin.example.com` });
    });

    afterAll(async () => {
      await app.close();
    });

    it("answers a preflight from an allowed origin with everything the request needs", async () => {
      const response = await request(app.getHttpServer())
        .options("/ping")
        .set("Origin", ALLOWED)
        .set("Access-Control-Request-Method", "PATCH")
        .set("Access-Control-Request-Headers", "authorization,if-match,idempotency-key")
        .expect(204);

      expect(response.headers["access-control-allow-origin"]).toBe(ALLOWED);
      expect(response.headers["access-control-allow-credentials"]).toBe("true");
      expect(response.headers["access-control-allow-methods"]).toContain("PATCH");
      expect(response.headers["access-control-allow-headers"]).toContain("If-Match");
      expect(response.headers["access-control-allow-headers"]).toContain("idempotency-key");
      expect(response.headers["access-control-max-age"]).toBe("600");
      expect(response.headers["vary"]).toContain("Origin");
    });

    it("tells an allowed origin which response headers it may read", async () => {
      const response = await request(app.getHttpServer())
        .get("/ping")
        .set("Origin", ALLOWED)
        .expect(200);

      // Without this, `ETag` and `Idempotency-Replayed` arrive and are
      // invisible to the client that has to send them back.
      expect(response.headers["access-control-expose-headers"]).toContain("ETag");
      expect(response.headers["access-control-expose-headers"]).toContain("Idempotency-Replayed");
    });

    it("withholds the header from an origin that is not on the list", async () => {
      const response = await request(app.getHttpServer())
        .get("/ping")
        .set("Origin", DENIED)
        .expect(200);

      // The request still runs — it is a browser that enforces CORS, and this
      // response never reaches the page that asked for it. What must not happen
      // is an `Access-Control-Allow-Origin` naming the caller.
      expect(response.headers["access-control-allow-origin"]).toBeUndefined();
    });

    it("answers a rejected preflight without a 500", async () => {
      // A disallowed origin passes `false` rather than an `Error` to the cors
      // callback. An error would reach `AllExceptionsFilter` and let any page
      // on the internet fill this service's error logs with traffic it chose.
      await request(app.getHttpServer())
        .options("/ping")
        .set("Origin", DENIED)
        .set("Access-Control-Request-Method", "GET")
        .expect((response) => {
          expect(response.status).toBeLessThan(500);
          expect(response.headers["access-control-allow-origin"]).toBeUndefined();
        });
    });

    it("still serves a request that carries no Origin", async () => {
      const response = await request(app.getHttpServer()).get("/ping").expect(200);

      expect(response.body).toEqual({ ok: true });
    });

    it("carries the security headers on every one of those answers", async () => {
      const response = await request(app.getHttpServer())
        .get("/ping")
        .set("Origin", ALLOWED)
        .expect(200);

      expect(response.headers["content-security-policy"]).toContain("default-src 'none'");
      expect(response.headers["strict-transport-security"]).toContain("preload");
    });
  });

  describe("on the Swagger UI page", () => {
    let app: INestApplication;

    beforeAll(async () => {
      app = await createSecuredApp({ ALLOWED_ORIGINS: ALLOWED }, setupSwagger);
    });

    afterAll(async () => {
      await app.close();
    });

    it("relaxes the policy only for the documentation page", async () => {
      const response = await request(app.getHttpServer()).get(`/${SWAGGER_PATH}`).expect(200);
      const policy = response.headers["content-security-policy"] ?? "";

      expect(policy).toContain("default-src 'self'");
      expect(policy).toContain("style-src 'self' 'unsafe-inline'");
      expect(policy).toContain("frame-ancestors 'none'");
    });

    it("serves a page the policy can actually render", async () => {
      // The claim `content-security-policy.ts` makes about this page, checked
      // against the page rather than asserted: every script it loads is
      // external and same-origin — so `script-src 'self'` is enough and no
      // `'unsafe-inline'` is needed there — while its styling is inline, which
      // is the one thing the policy concedes.
      const html = (await request(app.getHttpServer()).get(`/${SWAGGER_PATH}`).expect(200)).text;

      const scripts = [...html.matchAll(/<script\b[^>]*>/g)].map((match) => match[0]);
      expect(scripts.length).toBeGreaterThan(0);
      for (const tag of scripts) {
        expect(tag).toMatch(/\bsrc\s*=/);
        expect(tag).not.toMatch(/\bsrc\s*=\s*['"](?:https?:)?\/\//);
      }
      expect(html).toMatch(/<style>/);
    });

    it("keeps the OpenAPI document itself under the strict policy", async () => {
      // `/docs-json` is an API response that happens to live next to the page.
      const response = await request(app.getHttpServer()).get(`/${SWAGGER_PATH}-json`).expect(200);

      expect(response.headers["content-security-policy"]).toContain("default-src 'none'");
    });
  });

  describe("with a report collector configured", () => {
    let app: INestApplication;

    beforeAll(async () => {
      app = await createSecuredApp({
        ALLOWED_ORIGINS: ALLOWED,
        CSP_REPORT_ONLY: "true",
        CSP_REPORT_URI: "https://csp.example.com/report",
      });
    });

    afterAll(async () => {
      await app.close();
    });

    it("measures the policy instead of enforcing it", async () => {
      const response = await request(app.getHttpServer()).get("/ping").expect(200);

      expect(response.headers["content-security-policy-report-only"]).toContain(
        "report-uri https://csp.example.com/report",
      );
      expect(response.headers["content-security-policy"]).toBeUndefined();
    });
  });
});
