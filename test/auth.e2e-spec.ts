import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { createTestApp, type RecordingEmailQueue, type TestApp } from "./helpers/create-test-app";
import type { InMemoryPrismaService } from "./helpers/in-memory-prisma";
import type { InMemoryRefreshTokenStore } from "@/test-utils/in-memory-refresh-token.store";

describe("Auth (e2e)", () => {
  let app: INestApplication;
  let prisma: InMemoryPrismaService;
  let emails: RecordingEmailQueue;
  let refreshTokens: InMemoryRefreshTokenStore;

  beforeAll(async () => {
    const fixture: TestApp = await createTestApp();
    app = fixture.app;
    prisma = fixture.prisma;
    emails = fixture.emails;
    refreshTokens = fixture.refreshTokens;
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    prisma.reset();
    emails.reset();
    refreshTokens.reset();
  });

  const TEST_EMAIL = "e2e@example.com";
  // Credential value is set in test/helpers/setup-env.ts — not a real secret.
  const TEST_PASSWORD = process.env["E2E_TEST_PASSWORD"]!;
  const TEST_NAME = "E2E User";

  // ─── Register ────────────────────────────────────────────────────────────────

  describe("POST /v1/auth/register", () => {
    it("creates an account and returns access + refresh tokens", async () => {
      const res = await request(app.getHttpServer())
        .post("/v1/auth/register")
        .send({ email: TEST_EMAIL, password: TEST_PASSWORD, name: TEST_NAME })
        .expect(201);

      expect(res.body.success).toBe(true);
      expect(res.body.data).toMatchObject({
        accessToken: expect.any(String),
        refreshToken: expect.any(String),
        expiresIn: 900,
      });
    });

    it("queues a welcome email through the domain event bus", async () => {
      await request(app.getHttpServer())
        .post("/v1/auth/register")
        .send({ email: TEST_EMAIL, password: TEST_PASSWORD, name: TEST_NAME })
        .expect(201);

      // Nothing in the request path calls the queue. `AuthService` published
      // `user.registered`, the subscriber loader had wired `WelcomeEmailListener`
      // to it at bootstrap, and the listener enqueued this — the whole chain,
      // asserted from outside.
      expect(emails.enqueued).toContainEqual({
        job: "send-welcome",
        data: { to: TEST_EMAIL, name: TEST_NAME },
      });
    });

    it("still registers when the welcome email cannot be queued", async () => {
      jest.spyOn(emails, "sendWelcomeEmail").mockRejectedValueOnce(new Error("redis down"));

      await request(app.getHttpServer())
        .post("/v1/auth/register")
        .send({ email: TEST_EMAIL, password: TEST_PASSWORD, name: TEST_NAME })
        .expect(201);

      expect(prisma._users.size).toBe(1);
    });

    it("returns 409 when email is already registered", async () => {
      await request(app.getHttpServer())
        .post("/v1/auth/register")
        .send({ email: TEST_EMAIL, password: TEST_PASSWORD })
        .expect(201);

      const res = await request(app.getHttpServer())
        .post("/v1/auth/register")
        .send({ email: TEST_EMAIL, password: TEST_PASSWORD })
        .expect(409);

      expect(res.body.statusCode).toBe(409);
      expect(res.body.message).toMatch(/already in use/i);
    });

    it("returns 400 for an invalid email", async () => {
      const res = await request(app.getHttpServer())
        .post("/v1/auth/register")
        .send({ email: "not-an-email", password: TEST_PASSWORD })
        .expect(400);

      expect(res.body.statusCode).toBe(400);
    });

    it("returns 400 when password is too short", async () => {
      const res = await request(app.getHttpServer())
        .post("/v1/auth/register")
        .send({ email: TEST_EMAIL, password: "short" })
        .expect(400);

      expect(res.body.statusCode).toBe(400);
    });

    it("returns 400 when extra fields are provided", async () => {
      const res = await request(app.getHttpServer())
        .post("/v1/auth/register")
        .send({ email: TEST_EMAIL, password: TEST_PASSWORD, hackerField: "x" })
        .expect(400);

      expect(res.body.statusCode).toBe(400);
    });
  });

  // ─── Login ───────────────────────────────────────────────────────────────────

  describe("POST /v1/auth/login", () => {
    beforeEach(async () => {
      await request(app.getHttpServer())
        .post("/v1/auth/register")
        .send({ email: TEST_EMAIL, password: TEST_PASSWORD, name: TEST_NAME });
    });

    it("returns tokens on valid credentials", async () => {
      const res = await request(app.getHttpServer())
        .post("/v1/auth/login")
        .send({ email: TEST_EMAIL, password: TEST_PASSWORD })
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.data.accessToken).toBeTruthy();
      expect(res.body.data.refreshToken).toBeTruthy();
    });

    it("returns 401 for a wrong password", async () => {
      const res = await request(app.getHttpServer())
        .post("/v1/auth/login")
        .send({ email: TEST_EMAIL, password: process.env["E2E_WRONG_PASSWORD"]! })
        .expect(401);

      expect(res.body.statusCode).toBe(401);
      expect(res.body.message).toMatch(/invalid credentials/i);
    });

    it("returns 401 for an unknown email", async () => {
      const res = await request(app.getHttpServer())
        .post("/v1/auth/login")
        .send({ email: "nobody@example.com", password: TEST_PASSWORD })
        .expect(401);

      expect(res.body.statusCode).toBe(401);
    });

    it("returns 400 when email is missing", async () => {
      await request(app.getHttpServer())
        .post("/v1/auth/login")
        .send({ password: TEST_PASSWORD })
        .expect(400);
    });
  });

  // ─── Refresh ─────────────────────────────────────────────────────────────────

  describe("POST /v1/auth/refresh", () => {
    let refreshToken: string;

    beforeEach(async () => {
      const res = await request(app.getHttpServer())
        .post("/v1/auth/register")
        .send({ email: TEST_EMAIL, password: TEST_PASSWORD });
      refreshToken = res.body.data.refreshToken as string;
    });

    it("issues a new token pair and invalidates the old refresh token", async () => {
      const res = await request(app.getHttpServer())
        .post("/v1/auth/refresh")
        .send({ refreshToken })
        .expect(200);

      expect(res.body.data.accessToken).toBeTruthy();
      expect(res.body.data.refreshToken).toBeTruthy();
      expect(res.body.data.refreshToken).not.toBe(refreshToken);

      // Old token is consumed — using it again should fail
      const retry = await request(app.getHttpServer())
        .post("/v1/auth/refresh")
        .send({ refreshToken })
        .expect(401);

      expect(retry.body.statusCode).toBe(401);
    });

    it("returns 401 for a non-existent refresh token", async () => {
      const res = await request(app.getHttpServer())
        .post("/v1/auth/refresh")
        .send({ refreshToken: "00000000-0000-0000-0000-000000000000" })
        .expect(401);

      expect(res.body.statusCode).toBe(401);
    });

    it("returns 401 for an expired refresh token", async () => {
      const owner = [...prisma._users.values()][0]!;
      await refreshTokens.issue({
        token: "already-expired-token",
        userId: owner.id,
        expiresAt: new Date(Date.now() - 1_000),
      });

      await request(app.getHttpServer())
        .post("/v1/auth/refresh")
        .send({ refreshToken: "already-expired-token" })
        .expect(401);
    });

    it("spends an expired token rather than leaving it behind", async () => {
      // Expiry is the service's policy and the claim is the store's job, so a
      // rejected token is still consumed. Anything else accumulates rows nobody
      // can use.
      const owner = [...prisma._users.values()][0]!;
      await refreshTokens.issue({
        token: "expired-and-spent",
        userId: owner.id,
        expiresAt: new Date(Date.now() - 1_000),
      });

      await request(app.getHttpServer())
        .post("/v1/auth/refresh")
        .send({ refreshToken: "expired-and-spent" })
        .expect(401);

      expect(refreshTokens.has("expired-and-spent")).toBe(false);
    });

    it("answers the loser of a concurrent rotation with 401, not 500", async () => {
      // Both requests are in flight before either is awaited. Exactly one may
      // rotate; the other has to be told its token is invalid. Reading the row
      // and then deleting it answered the loser with a driver error, which this
      // application renders as a 500.
      const responses = await Promise.all([
        request(app.getHttpServer()).post("/v1/auth/refresh").send({ refreshToken }),
        request(app.getHttpServer()).post("/v1/auth/refresh").send({ refreshToken }),
      ]);

      const statuses = responses.map((response) => response.status).sort();
      expect(statuses).toEqual([200, 401]);
    });
  });

  // ─── Logout ──────────────────────────────────────────────────────────────────

  describe("POST /v1/auth/logout", () => {
    let accessToken: string;
    let refreshToken: string;

    beforeEach(async () => {
      const res = await request(app.getHttpServer())
        .post("/v1/auth/register")
        .send({ email: TEST_EMAIL, password: TEST_PASSWORD });
      accessToken = res.body.data.accessToken as string;
      refreshToken = res.body.data.refreshToken as string;
    });

    it("revokes the refresh token and returns 204", async () => {
      await request(app.getHttpServer())
        .post("/v1/auth/logout")
        .set("Authorization", `Bearer ${accessToken}`)
        .send({ refreshToken })
        .expect(204);

      // Token is now gone from the store
      expect(refreshTokens.has(refreshToken)).toBe(false);
    });

    it("returns 401 without a bearer token", async () => {
      await request(app.getHttpServer()).post("/v1/auth/logout").send({ refreshToken }).expect(401);
    });
  });

  // ─── Me ──────────────────────────────────────────────────────────────────────

  describe("GET /v1/auth/me", () => {
    let accessToken: string;

    beforeEach(async () => {
      const res = await request(app.getHttpServer())
        .post("/v1/auth/register")
        .send({ email: TEST_EMAIL, password: TEST_PASSWORD, name: TEST_NAME });
      accessToken = res.body.data.accessToken as string;
    });

    it("returns the authenticated user's profile", async () => {
      const res = await request(app.getHttpServer())
        .get("/v1/auth/me")
        .set("Authorization", `Bearer ${accessToken}`)
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.data).toMatchObject({
        email: TEST_EMAIL,
        role: "USER",
      });
    });

    it("returns 401 without a bearer token", async () => {
      await request(app.getHttpServer()).get("/v1/auth/me").expect(401);
    });

    it("returns 401 with a malformed token", async () => {
      await request(app.getHttpServer())
        .get("/v1/auth/me")
        .set("Authorization", "Bearer not.a.real.token")
        .expect(401);
    });
  });
});
