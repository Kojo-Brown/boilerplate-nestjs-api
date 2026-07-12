import type { INestApplication } from "@nestjs/common";
import * as request from "supertest";
import { createTestApp, type TestApp } from "./helpers/create-test-app";
import type { InMemoryPrismaService } from "./helpers/in-memory-prisma";

describe("Auth (e2e)", () => {
  let app: INestApplication;
  let prisma: InMemoryPrismaService;

  beforeAll(async () => {
    const fixture: TestApp = await createTestApp();
    app = fixture.app;
    prisma = fixture.prisma;
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    prisma.reset();
  });

  const TEST_EMAIL = "e2e@example.com";
  const TEST_PASSWORD = "P@ssw0rd123!";
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
        .send({ email: TEST_EMAIL, password: "WrongP@ssw0rd!" })
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
      // Manually expire the token in the store
      const stored = prisma._refreshTokens.get(refreshToken);
      if (stored) {
        stored.expiresAt = new Date(Date.now() - 1000);
        prisma._refreshTokens.set(refreshToken, stored);
      }

      await request(app.getHttpServer())
        .post("/v1/auth/refresh")
        .send({ refreshToken })
        .expect(401);
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
      expect(prisma._refreshTokens.has(refreshToken)).toBe(false);
    });

    it("returns 401 without a bearer token", async () => {
      await request(app.getHttpServer())
        .post("/v1/auth/logout")
        .send({ refreshToken })
        .expect(401);
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
