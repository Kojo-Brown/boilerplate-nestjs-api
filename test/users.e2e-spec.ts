import type { INestApplication } from "@nestjs/common";
import { Role } from "@prisma/client";
import * as request from "supertest";
import { createTestApp, type TestApp } from "./helpers/create-test-app";
import type { InMemoryPrismaService } from "./helpers/in-memory-prisma";

describe("Users (e2e)", () => {
  let app: INestApplication;
  let prisma: InMemoryPrismaService;

  let userToken: string;
  let adminToken: string;
  let userId: string;
  let adminId: string;

  beforeAll(async () => {
    const fixture: TestApp = await createTestApp();
    app = fixture.app;
    prisma = fixture.prisma;
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    prisma.reset();

    // Register a regular user
    const userRes = await request(app.getHttpServer())
      .post("/v1/auth/register")
      .send({ email: "user@example.com", password: "P@ssw0rd123!", name: "Regular User" });
    userToken = userRes.body.data.accessToken as string;
    userId = [...prisma._users.values()].find((u) => u.email === "user@example.com")?.id ?? "";

    // Register admin (role starts as USER after register)
    await request(app.getHttpServer())
      .post("/v1/auth/register")
      .send({ email: "admin@example.com", password: "P@ssw0rd123!", name: "Admin User" });
    adminId = [...prisma._users.values()].find((u) => u.email === "admin@example.com")?.id ?? "";

    // Promote to ADMIN in the in-memory store
    await prisma.user.update({ where: { id: adminId }, data: { role: Role.ADMIN } });

    // Re-login so the issued JWT carries the ADMIN role
    const adminLogin = await request(app.getHttpServer())
      .post("/v1/auth/login")
      .send({ email: "admin@example.com", password: "P@ssw0rd123!" });
    adminToken = adminLogin.body.data.accessToken as string;
  });

  // ─── List users ───────────────────────────────────────────────────────────────

  describe("GET /v1/users", () => {
    it("returns a paginated list for admin", async () => {
      const res = await request(app.getHttpServer())
        .get("/v1/users")
        .set("Authorization", `Bearer ${adminToken}`)
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(Array.isArray(res.body.data.items)).toBe(true);
      expect(res.body.data.items.length).toBeGreaterThanOrEqual(2);
      expect(res.body.data).toHaveProperty("nextCursor");
      expect(res.body.data).toHaveProperty("hasNextPage");
    });

    it("returns 403 for a regular user", async () => {
      const res = await request(app.getHttpServer())
        .get("/v1/users")
        .set("Authorization", `Bearer ${userToken}`)
        .expect(403);

      expect(res.body.statusCode).toBe(403);
    });

    it("returns 401 without authentication", async () => {
      await request(app.getHttpServer()).get("/v1/users").expect(401);
    });

    it("respects the limit query parameter", async () => {
      const res = await request(app.getHttpServer())
        .get("/v1/users?limit=1")
        .set("Authorization", `Bearer ${adminToken}`)
        .expect(200);

      expect(res.body.data.items.length).toBe(1);
      expect(res.body.data.hasNextPage).toBe(true);
    });

    it("filters users by the search query parameter", async () => {
      const res = await request(app.getHttpServer())
        .get("/v1/users?search=Regular")
        .set("Authorization", `Bearer ${adminToken}`)
        .expect(200);

      expect(res.body.data.items.every((u: { name: string }) => u.name?.includes("Regular"))).toBe(true);
    });
  });

  // ─── Get user by id ──────────────────────────────────────────────────────────

  describe("GET /v1/users/:id", () => {
    it("returns the user for a valid id", async () => {
      const res = await request(app.getHttpServer())
        .get(`/v1/users/${userId}`)
        .set("Authorization", `Bearer ${userToken}`)
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.data).toMatchObject({
        id: userId,
        email: "user@example.com",
        role: "USER",
        name: "Regular User",
      });
    });

    it("returns 404 for an unknown id", async () => {
      const res = await request(app.getHttpServer())
        .get("/v1/users/nonexistent-id-xyz")
        .set("Authorization", `Bearer ${userToken}`)
        .expect(404);

      expect(res.body.statusCode).toBe(404);
    });

    it("returns 401 without authentication", async () => {
      await request(app.getHttpServer()).get(`/v1/users/${userId}`).expect(401);
    });
  });

  // ─── Update user ─────────────────────────────────────────────────────────────

  describe("PATCH /v1/users/:id", () => {
    it("allows a user to update their own name", async () => {
      const res = await request(app.getHttpServer())
        .patch(`/v1/users/${userId}`)
        .set("Authorization", `Bearer ${userToken}`)
        .send({ name: "Updated Name" })
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.data.name).toBe("Updated Name");
      expect(res.body.data.id).toBe(userId);
    });

    it("allows an admin to update any user's profile", async () => {
      const res = await request(app.getHttpServer())
        .patch(`/v1/users/${userId}`)
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ name: "Admin-Set Name" })
        .expect(200);

      expect(res.body.data.name).toBe("Admin-Set Name");
    });

    it("returns 403 when a regular user tries to update another user", async () => {
      const res = await request(app.getHttpServer())
        .patch(`/v1/users/${adminId}`)
        .set("Authorization", `Bearer ${userToken}`)
        .send({ name: "Hacked" })
        .expect(403);

      expect(res.body.statusCode).toBe(403);
    });

    it("returns 404 when updating a non-existent user (admin)", async () => {
      const res = await request(app.getHttpServer())
        .patch("/v1/users/does-not-exist")
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ name: "Ghost" })
        .expect(404);

      expect(res.body.statusCode).toBe(404);
    });

    it("returns 401 without authentication", async () => {
      await request(app.getHttpServer())
        .patch(`/v1/users/${userId}`)
        .send({ name: "No Auth" })
        .expect(401);
    });
  });

  // ─── Delete user ─────────────────────────────────────────────────────────────

  describe("DELETE /v1/users/:id", () => {
    it("allows admin to delete a user and returns 204", async () => {
      await request(app.getHttpServer())
        .delete(`/v1/users/${userId}`)
        .set("Authorization", `Bearer ${adminToken}`)
        .expect(204);

      expect(prisma._users.has(userId)).toBe(false);
    });

    it("returns 403 for a regular user", async () => {
      const res = await request(app.getHttpServer())
        .delete(`/v1/users/${adminId}`)
        .set("Authorization", `Bearer ${userToken}`)
        .expect(403);

      expect(res.body.statusCode).toBe(403);
    });

    it("returns 404 when deleting a non-existent user (admin)", async () => {
      const res = await request(app.getHttpServer())
        .delete("/v1/users/does-not-exist")
        .set("Authorization", `Bearer ${adminToken}`)
        .expect(404);

      expect(res.body.statusCode).toBe(404);
    });

    it("returns 401 without authentication", async () => {
      await request(app.getHttpServer()).delete(`/v1/users/${userId}`).expect(401);
    });
  });

  // ─── Error format ─────────────────────────────────────────────────────────────

  describe("Error response format", () => {
    it("returns 400 for an invalid PATCH body (unknown field)", async () => {
      const res = await request(app.getHttpServer())
        .patch(`/v1/users/${userId}`)
        .set("Authorization", `Bearer ${userToken}`)
        .send({ unknownField: "value" })
        .expect(400);

      expect(res.body.statusCode).toBe(400);
    });

    it("returns structured JSON with statusCode, message, path, and timestamp on 404", async () => {
      const res = await request(app.getHttpServer())
        .get("/v1/users/no-such-user-here")
        .set("Authorization", `Bearer ${userToken}`)
        .expect(404);

      expect(res.body).toMatchObject({
        statusCode: 404,
        message: expect.any(String),
        path: expect.stringContaining("/v1/users/no-such-user-here"),
        timestamp: expect.any(String),
      });
    });
  });
});
