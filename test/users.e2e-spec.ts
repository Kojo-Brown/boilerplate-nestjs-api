import type { INestApplication } from "@nestjs/common";
import { Role } from "@prisma/client";
import request from "supertest";
import { createTestApp, type TestApp } from "./helpers/create-test-app";
import { UpdateUserPreferencesHandler } from "@/users/write";
import { isDeeplyFrozen } from "@/common/immutable";
import type { UpdateUserPreferencesDto } from "@/users/dto/update-user-preferences.dto";
import type { InMemoryPrismaService } from "./helpers/in-memory-prisma";

describe("Users (e2e)", () => {
  let app: INestApplication;
  let prisma: InMemoryPrismaService;
  let drainOutbox: TestApp["drainOutbox"];

  // Captured before any spy replaces it, so the spy can still perform the
  // real write and the request goes through end to end.
  const executeUpdatePreferences = UpdateUserPreferencesHandler.prototype.execute;

  let userToken: string;
  let adminToken: string;
  let userId: string;
  let adminId: string;

  beforeAll(async () => {
    const fixture: TestApp = await createTestApp();
    app = fixture.app;
    prisma = fixture.prisma;
    drainOutbox = fixture.drainOutbox;
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    prisma.reset();

    // Register a regular user
    const userRes = await request(app.getHttpServer()).post("/v1/auth/register").send({
      email: "user@example.com",
      password: process.env["E2E_TEST_PASSWORD"]!,
      name: "Regular User",
    });
    userToken = userRes.body.data.accessToken as string;
    userId = [...prisma._users.values()].find((u) => u.email === "user@example.com")?.id ?? "";

    // Register admin (role starts as USER after register)
    await request(app.getHttpServer()).post("/v1/auth/register").send({
      email: "admin@example.com",
      password: process.env["E2E_TEST_PASSWORD"]!,
      name: "Admin User",
    });
    adminId = [...prisma._users.values()].find((u) => u.email === "admin@example.com")?.id ?? "";

    // Promote to ADMIN in the in-memory store
    await prisma.user.update({ where: { id: adminId }, data: { role: Role.ADMIN } });

    // Re-login so the issued JWT carries the ADMIN role
    const adminLogin = await request(app.getHttpServer())
      .post("/v1/auth/login")
      .send({ email: "admin@example.com", password: process.env["E2E_TEST_PASSWORD"]! });
    adminToken = adminLogin.body.data.accessToken as string;
  });

  const emailsIn = (res: { body: { data: { items: { email: string }[] } } }): string[] =>
    res.body.data.items.map((user) => user.email);

  /**
   * Yields once to the CQRS event bus.
   *
   * `EventBus.publish` is `subject$.next(event)` — it returns before any
   * `@EventsHandler` has finished, by design, so `drainOutbox()` resolving
   * means the event was *delivered*, not that every projection has run. One
   * `setImmediate` is enough and is not a sleep: the projection's work is a
   * chain of promises, and every pending microtask is drained before a
   * macrotask callback runs.
   */
  const projectionsSettled = () => new Promise((resolve) => setImmediate(resolve));

  /**
   * Reads the validator a client must hold before it may write.
   *
   * Round-tripped rather than hardcoded to `"0"`: the version a freshly
   * registered user is at is an implementation detail, and a test that assumed
   * one would start failing the day registration wrote to the row twice.
   */
  async function currentEtag(path: string, token: string): Promise<string> {
    const res = await request(app.getHttpServer())
      .get(path)
      .set("Authorization", `Bearer ${token}`)
      .expect(200);

    const etag = res.headers["etag"];
    if (typeof etag !== "string") {
      throw new Error(`GET ${path} returned no ETag; there is nothing to write against`);
    }
    return etag;
  }

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

    /**
     * The read model catching up with a write it did not make.
     *
     * `GET /v1/users` is cached for 60s under one key, and registration happens
     * in `AuthService`, which knows nothing about that cache. Before
     * `UsersReadModelProjector` nothing connected the two, so a newly
     * registered account was absent from this list for the full TTL — not
     * wrong, just old, which is why it was never reported. The chain under test
     * is the whole one: the row and `user.registered` commit together, the
     * relay publishes, the CQRS bridge forwards, and the projection evicts.
     */
    it("shows a newly registered user, though the list was cached before they existed", async () => {
      // Populate the cache with a page that predates the new account.
      const before = await request(app.getHttpServer())
        .get("/v1/users")
        .set("Authorization", `Bearer ${adminToken}`)
        .expect(200);
      expect(emailsIn(before)).not.toContain("newcomer@example.com");

      await request(app.getHttpServer())
        .post("/v1/auth/register")
        .send({
          email: "newcomer@example.com",
          password: process.env["E2E_TEST_PASSWORD"]!,
          name: "Newcomer",
        })
        .expect(201);
      await drainOutbox();
      await projectionsSettled();

      const after = await request(app.getHttpServer())
        .get("/v1/users")
        .set("Authorization", `Bearer ${adminToken}`)
        .expect(200);

      expect(emailsIn(after)).toContain("newcomer@example.com");
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

      expect(res.body.data.items.every((u: { name: string }) => u.name?.includes("Regular"))).toBe(
        true,
      );
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
        .set("If-Match", await currentEtag(`/v1/users/${userId}`, userToken))
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
        .set("If-Match", await currentEtag(`/v1/users/${userId}`, adminToken))
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
        .set("If-Match", await currentEtag(`/v1/users/${userId}`, adminToken))
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

  // ─── Notification preferences ─────────────────────────────────────────────────

  describe("/v1/users/:id/preferences", () => {
    it("returns a flag for every notification channel, defaulted", async () => {
      const res = await request(app.getHttpServer())
        .get(`/v1/users/${userId}/preferences`)
        .set("Authorization", `Bearer ${userToken}`)
        .expect(200);

      // One flag per channel in `NOTIFICATION_CHANNEL_NAMES`. A channel with no
      // flag would be undefined here and silently off for every user.
      expect(res.body.data).toMatchObject({
        emailNotifications: true,
        smsNotifications: false,
        pushNotifications: false,
      });
    });

    it("round-trips a channel opt-in through validation and the store", async () => {
      const patched = await request(app.getHttpServer())
        .patch(`/v1/users/${userId}/preferences`)
        .set("Authorization", `Bearer ${userToken}`)
        .set("If-Match", await currentEtag(`/v1/users/${userId}/preferences`, userToken))
        .send({ smsNotifications: true })
        .expect(200);

      expect(patched.body.data.smsNotifications).toBe(true);
      // Merged, not replaced: opting into SMS must not silently switch email off.
      expect(patched.body.data.emailNotifications).toBe(true);

      const reread = await request(app.getHttpServer())
        .get(`/v1/users/${userId}/preferences`)
        .set("Authorization", `Bearer ${userToken}`)
        .expect(200);

      expect(reread.body.data.smsNotifications).toBe(true);
    });

    it("hands the handler a frozen DTO, through the real pipe chain", async () => {
      // Without this, nothing fails if `DeepFreezePipe` is dropped from the
      // global pipes: no handler in the codebase mutates its own payload today,
      // so the guard would silently become inert and only stop catching things.
      // Spying on the handler the bus dispatches to is what makes this an
      // assertion about the *wiring* — the DTO has been through
      // `ValidationPipe`, `class-transformer` and the freeze by the time it
      // arrives here.
      const handler = app.get(UpdateUserPreferencesHandler);
      const received: unknown[] = [];
      const spy = jest.spyOn(handler, "execute").mockImplementation(async (command) => {
        received.push(command.dto);
        return executeUpdatePreferences.call(handler, command);
      });

      try {
        await request(app.getHttpServer())
          .patch(`/v1/users/${userId}/preferences`)
          .set("Authorization", `Bearer ${userToken}`)
          .set("If-Match", await currentEtag(`/v1/users/${userId}/preferences`, userToken))
          .send({ pushNotifications: true })
          .expect(200);
      } finally {
        spy.mockRestore();
      }

      expect(received).toHaveLength(1);
      const dto = received[0] as UpdateUserPreferencesDto;
      expect(isDeeplyFrozen(dto)).toBe(true);
      expect(() => {
        (dto as { pushNotifications?: boolean }).pushNotifications = false;
      }).toThrow(TypeError);
    });

    it("rejects a preference key the DTO does not declare", async () => {
      await request(app.getHttpServer())
        .patch(`/v1/users/${userId}/preferences`)
        .set("Authorization", `Bearer ${userToken}`)
        .send({ smsNotifications: true, telepathyNotifications: true })
        .expect(400);
    });

    it("returns 403 when reading another user's preferences", async () => {
      await request(app.getHttpServer())
        .get(`/v1/users/${adminId}/preferences`)
        .set("Authorization", `Bearer ${userToken}`)
        .expect(403);
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

  // ─── Optimistic concurrency ──────────────────────────────────────────────────

  describe("ETag / If-Match", () => {
    it("returns a strong ETag on a read, which is what a write must echo", async () => {
      const res = await request(app.getHttpServer())
        .get(`/v1/users/${userId}`)
        .set("Authorization", `Bearer ${userToken}`)
        .expect(200);

      expect(res.headers["etag"]).toBe('"0"');
      expect(res.body.data.version).toBe(0);
    });

    it("keeps the ETag stable across reads of an unchanged resource", async () => {
      // Express would otherwise digest the response body, whose envelope
      // carries a fresh `meta.timestamp` every time — a validator that changed
      // on every read would make If-Match useless.
      const first = await request(app.getHttpServer())
        .get(`/v1/users/${userId}`)
        .set("Authorization", `Bearer ${userToken}`);
      const second = await request(app.getHttpServer())
        .get(`/v1/users/${userId}`)
        .set("Authorization", `Bearer ${userToken}`);

      expect(second.headers["etag"]).toBe(first.headers["etag"]);
      expect(second.text).not.toBe(first.text);
    });

    it("advances the ETag on a successful write and returns the new one", async () => {
      const res = await request(app.getHttpServer())
        .patch(`/v1/users/${userId}`)
        .set("Authorization", `Bearer ${userToken}`)
        .set("If-Match", '"0"')
        .send({ name: "Ada" })
        .expect(200);

      expect(res.headers["etag"]).toBe('"1"');
      expect(res.body.data.version).toBe(1);
    });

    it("serves the advanced ETag on the next read, not a cached one", async () => {
      // `GET /users/:id` is cached for 30s. Before this feature the cache was
      // keyed by URL while the invalidation used a different key, so the read
      // came back pre-update — and would now hand out an ETag naming a version
      // that no longer exists, refusing the client's own next write.
      await request(app.getHttpServer())
        .get(`/v1/users/${userId}`)
        .set("Authorization", `Bearer ${userToken}`)
        .expect(200);

      await request(app.getHttpServer())
        .patch(`/v1/users/${userId}`)
        .set("Authorization", `Bearer ${userToken}`)
        .set("If-Match", '"0"')
        .send({ name: "Ada" })
        .expect(200);

      const reread = await request(app.getHttpServer())
        .get(`/v1/users/${userId}`)
        .set("Authorization", `Bearer ${userToken}`)
        .expect(200);

      expect(reread.headers["etag"]).toBe('"1"');
      expect(reread.body.data.name).toBe("Ada");
    });

    it("answers 428 when a mutating request names no version", async () => {
      const res = await request(app.getHttpServer())
        .patch(`/v1/users/${userId}`)
        .set("Authorization", `Bearer ${userToken}`)
        .send({ name: "Ada" })
        .expect(428);

      expect(res.body.statusCode).toBe(428);
      expect(res.body.message).toMatch(/ETag/);
    });

    it("answers 412 when the resource has moved past the version named", async () => {
      const etag = await currentEtag(`/v1/users/${userId}`, userToken);

      await request(app.getHttpServer())
        .patch(`/v1/users/${userId}`)
        .set("Authorization", `Bearer ${userToken}`)
        .set("If-Match", etag)
        .send({ name: "First" })
        .expect(200);

      // The second writer is still holding the validator it read before the
      // first one landed — the lost update this whole feature exists to refuse.
      const conflict = await request(app.getHttpServer())
        .patch(`/v1/users/${userId}`)
        .set("Authorization", `Bearer ${userToken}`)
        .set("If-Match", etag)
        .send({ name: "Second" })
        .expect(412);

      expect(conflict.body.message).toContain('"1"');
    });

    it("leaves the winner's value in place after a refused write", async () => {
      const etag = await currentEtag(`/v1/users/${userId}`, userToken);

      await request(app.getHttpServer())
        .patch(`/v1/users/${userId}`)
        .set("Authorization", `Bearer ${userToken}`)
        .set("If-Match", etag)
        .send({ name: "First" });

      await request(app.getHttpServer())
        .patch(`/v1/users/${userId}`)
        .set("Authorization", `Bearer ${userToken}`)
        .set("If-Match", etag)
        .send({ name: "Second" })
        .expect(412);

      const reread = await request(app.getHttpServer())
        .get(`/v1/users/${userId}`)
        .set("Authorization", `Bearer ${userToken}`);

      expect(reread.body.data.name).toBe("First");
    });

    it("lets the loser succeed once it re-reads and retries", async () => {
      // The full read-modify-write loop a client is expected to run. It has to
      // terminate, which is what the cache-key alignment above is for.
      const stale = await currentEtag(`/v1/users/${userId}`, userToken);

      await request(app.getHttpServer())
        .patch(`/v1/users/${userId}`)
        .set("Authorization", `Bearer ${userToken}`)
        .set("If-Match", stale)
        .send({ name: "First" })
        .expect(200);

      await request(app.getHttpServer())
        .patch(`/v1/users/${userId}`)
        .set("Authorization", `Bearer ${userToken}`)
        .set("If-Match", stale)
        .send({ name: "Second" })
        .expect(412);

      const fresh = await currentEtag(`/v1/users/${userId}`, userToken);

      await request(app.getHttpServer())
        .patch(`/v1/users/${userId}`)
        .set("Authorization", `Bearer ${userToken}`)
        .set("If-Match", fresh)
        .send({ name: "Second" })
        .expect(200);
    });

    it("accepts `*` as a precondition asserting only that the user exists", async () => {
      await request(app.getHttpServer())
        .patch(`/v1/users/${userId}`)
        .set("Authorization", `Bearer ${userToken}`)
        .set("If-Match", "*")
        .send({ name: "Ada" })
        .expect(200);
    });

    it("accepts a list of entity-tags when any one of them matches", async () => {
      await request(app.getHttpServer())
        .patch(`/v1/users/${userId}`)
        .set("Authorization", `Bearer ${userToken}`)
        .set("If-Match", '"7", "0"')
        .send({ name: "Ada" })
        .expect(200);
    });

    it("answers 412 for a weak entity-tag, which If-Match compares strongly", async () => {
      await request(app.getHttpServer())
        .patch(`/v1/users/${userId}`)
        .set("Authorization", `Bearer ${userToken}`)
        .set("If-Match", 'W/"0"')
        .send({ name: "Ada" })
        .expect(412);
    });

    it("answers 400 for a malformed If-Match rather than ignoring it", async () => {
      await request(app.getHttpServer())
        .patch(`/v1/users/${userId}`)
        .set("Authorization", `Bearer ${userToken}`)
        .set("If-Match", "0")
        .send({ name: "Ada" })
        .expect(400);
    });

    // RFC 9110 §13.2.1: preconditions are evaluated after the server's normal
    // request checks. Getting this backwards sends a client round a loop —
    // fix the header, learn the body was wrong; fix the body, learn it never
    // had permission.
    it("answers 400 for an invalid body before complaining about a missing If-Match", async () => {
      await request(app.getHttpServer())
        .patch(`/v1/users/${userId}`)
        .set("Authorization", `Bearer ${userToken}`)
        .send({ unknownField: "value" })
        .expect(400);
    });

    it("answers 403 to a stranger before complaining about a missing If-Match", async () => {
      await request(app.getHttpServer())
        .patch(`/v1/users/${adminId}`)
        .set("Authorization", `Bearer ${userToken}`)
        .send({ name: "Hacked" })
        .expect(403);
    });

    it("answers 404 for an unknown user before complaining about a missing If-Match", async () => {
      await request(app.getHttpServer())
        .patch("/v1/users/nonexistent-id-xyz")
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ name: "Nobody" })
        .expect(404);
    });

    it("refuses a delete against a stale version and keeps the row", async () => {
      const etag = await currentEtag(`/v1/users/${userId}`, adminToken);

      await request(app.getHttpServer())
        .patch(`/v1/users/${userId}`)
        .set("Authorization", `Bearer ${userToken}`)
        .set("If-Match", etag)
        .send({ name: "Moved" })
        .expect(200);

      await request(app.getHttpServer())
        .delete(`/v1/users/${userId}`)
        .set("Authorization", `Bearer ${adminToken}`)
        .set("If-Match", etag)
        .expect(412);

      expect(prisma._users.has(userId)).toBe(true);
    });

    it("shares one validator between a user and their preferences", async () => {
      // Preferences are a JSON column on the user row, so a profile edit moves
      // the validator a preferences write is holding. Conservative on purpose:
      // one row, one version, no second counter for a client to confuse.
      const etag = await currentEtag(`/v1/users/${userId}/preferences`, userToken);

      await request(app.getHttpServer())
        .patch(`/v1/users/${userId}`)
        .set("Authorization", `Bearer ${userToken}`)
        .set("If-Match", etag)
        .send({ name: "Ada" })
        .expect(200);

      await request(app.getHttpServer())
        .patch(`/v1/users/${userId}/preferences`)
        .set("Authorization", `Bearer ${userToken}`)
        .set("If-Match", etag)
        .send({ smsNotifications: true })
        .expect(412);
    });

    it("advances the shared validator when preferences are written", async () => {
      await request(app.getHttpServer())
        .patch(`/v1/users/${userId}/preferences`)
        .set("Authorization", `Bearer ${userToken}`)
        .set("If-Match", '"0"')
        .send({ smsNotifications: true })
        .expect(200);

      const user = await request(app.getHttpServer())
        .get(`/v1/users/${userId}`)
        .set("Authorization", `Bearer ${userToken}`);

      expect(user.headers["etag"]).toBe('"1"');
    });

    it("spends no upload on an avatar request that has already lost", async () => {
      const stale = await currentEtag(`/v1/users/${userId}`, userToken);

      await request(app.getHttpServer())
        .patch(`/v1/users/${userId}`)
        .set("Authorization", `Bearer ${userToken}`)
        .set("If-Match", stale)
        .send({ name: "Moved" })
        .expect(200);

      await request(app.getHttpServer())
        .post(`/v1/users/${userId}/avatar`)
        .set("Authorization", `Bearer ${userToken}`)
        .set("If-Match", stale)
        .attach("file", Buffer.from("fake-jpeg-bytes"), {
          filename: "photo.jpg",
          contentType: "image/jpeg",
        })
        .expect(412);
    });
  });
});
