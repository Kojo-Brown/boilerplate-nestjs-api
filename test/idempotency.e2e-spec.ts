import type { INestApplication } from "@nestjs/common";
import { HttpStatus } from "@nestjs/common";
import { Role } from "@prisma/client";
import request from "supertest";
import { createTestApp, type TestApp } from "./helpers/create-test-app";
import { IDEMPOTENCY_REPLAYED_HEADER } from "@/common/idempotency";
import type { InMemoryPrismaService } from "./helpers/in-memory-prisma";

/**
 * `Idempotency-Key`, seen from outside.
 *
 * The unit suites prove the interceptor's decisions and the contract proves
 * both stores make them the same way. This one proves the wiring — that the
 * interceptor is bound ahead of `ResponseEnvelopeInterceptor`, that what it
 * records is the enveloped body a client actually received rather than the
 * handler's return value, that a replay comes back byte-identical through a
 * real HTTP stack, and that an error rendered by `AllExceptionsFilter` is
 * recorded too.
 *
 * `setup-env.ts` leaves `IDEMPOTENCY_STORE` unset, so the app runs on the
 * in-memory store — the default a clean clone gets.
 */
describe("Idempotency (e2e)", () => {
  const EMAIL = "idempotency-user@example.com";
  const ADMIN_EMAIL = "idempotency-admin@example.com";

  let app: INestApplication;
  let prisma: InMemoryPrismaService;
  let token: string;
  let userId: string;
  let adminToken: string;

  /** Distinct per test, so one test's record is never another's replay. */
  let keyCounter = 0;
  const nextKey = (): string => `e2e-idempotency-key-${(keyCounter += 1)}`;

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

    const registered = await request(app.getHttpServer()).post("/v1/auth/register").send({
      email: EMAIL,
      password: process.env["E2E_TEST_PASSWORD"],
      name: "Idempotency User",
    });

    token = registered.body.data.accessToken as string;
    userId = [...prisma._users.values()].find((user) => user.email === EMAIL)?.id ?? "";

    // Deleting a user is admin-only, and a retried delete is the clearest case
    // for replaying a 204, so the suite needs one. Same promote-then-re-login
    // dance as `users.e2e-spec.ts`, for the same reason: the role has to be in
    // the issued JWT.
    await request(app.getHttpServer()).post("/v1/auth/register").send({
      email: ADMIN_EMAIL,
      password: process.env["E2E_TEST_PASSWORD"],
      name: "Idempotency Admin",
    });
    const adminId =
      [...prisma._users.values()].find((user) => user.email === ADMIN_EMAIL)?.id ?? "";
    await prisma.user.update({ where: { id: adminId }, data: { role: Role.ADMIN } });
    const adminLogin = await request(app.getHttpServer()).post("/v1/auth/login").send({
      email: ADMIN_EMAIL,
      password: process.env["E2E_TEST_PASSWORD"],
    });
    adminToken = adminLogin.body.data.accessToken as string;
  });

  describe("without the header", () => {
    it("leaves existing routes exactly as they were", async () => {
      // The feature is opt-in per request. Every other e2e suite in this repo
      // is the regression test for that, but saying so once here makes the
      // intent explicit rather than incidental.
      const first = await request(app.getHttpServer())
        .patch(`/v1/users/${userId}`)
        .set("Authorization", `Bearer ${token}`)
        .send({ name: "First" });
      const second = await request(app.getHttpServer())
        .patch(`/v1/users/${userId}`)
        .set("Authorization", `Bearer ${token}`)
        .send({ name: "Second" });

      expect(first.status).toBe(HttpStatus.OK);
      expect(second.body.data.name).toBe("Second");
      expect(second.headers[IDEMPOTENCY_REPLAYED_HEADER.toLowerCase()]).toBeUndefined();
    });
  });

  describe("with the header", () => {
    it("replays the first response byte for byte and does not run the handler again", async () => {
      const key = nextKey();

      const first = await request(app.getHttpServer())
        .patch(`/v1/users/${userId}`)
        .set("Authorization", `Bearer ${token}`)
        .set("Idempotency-Key", key)
        .send({ name: "Ada" });

      // A different name under the same key would be a *different* request and
      // is refused below. This retry is the same request arriving twice, which
      // is the case the header exists for.
      const retry = await request(app.getHttpServer())
        .patch(`/v1/users/${userId}`)
        .set("Authorization", `Bearer ${token}`)
        .set("Idempotency-Key", key)
        .send({ name: "Ada" });

      expect(first.status).toBe(HttpStatus.OK);
      expect(retry.status).toBe(first.status);
      expect(retry.text).toBe(first.text);
      expect(retry.headers["content-type"]).toBe(first.headers["content-type"]);
      expect(retry.headers[IDEMPOTENCY_REPLAYED_HEADER.toLowerCase()]).toBe("true");
    });

    it("records the enveloped body, not the handler's return value", async () => {
      // The interceptor is bound above `ResponseEnvelopeInterceptor`, so what it
      // captures is what the client received. Reading the handler's value
      // instead would replay an unwrapped object and change the response shape
      // on the second call.
      const key = nextKey();
      const send = () =>
        request(app.getHttpServer())
          .patch(`/v1/users/${userId}`)
          .set("Authorization", `Bearer ${token}`)
          .set("Idempotency-Key", key)
          .send({ name: "Grace" });

      await send();
      const retry = await send();

      expect(retry.body).toMatchObject({
        success: true,
        data: { id: userId, name: "Grace" },
        meta: { version: "v1" },
      });
    });

    it("replays a 204 as a 204 with no body", async () => {
      const key = nextKey();
      const send = () =>
        request(app.getHttpServer())
          .delete(`/v1/users/${userId}`)
          .set("Authorization", `Bearer ${adminToken}`)
          .set("Idempotency-Key", key);

      const first = await send();
      const retry = await send();

      // Without the record the retry would 404: the row is gone. That is the
      // point — a retried delete should look like it succeeded, once.
      expect(first.status).toBe(HttpStatus.NO_CONTENT);
      expect(retry.status).toBe(HttpStatus.NO_CONTENT);
      expect(retry.text).toBe("");
      expect(retry.headers[IDEMPOTENCY_REPLAYED_HEADER.toLowerCase()]).toBe("true");
    });

    it("replays an error response the exception filter rendered", async () => {
      // The recorded bytes are read off the response, after every filter has
      // run, so a 4xx replays like any other outcome. A client that reuses the
      // key gets the same refusal rather than a second attempt.
      const key = nextKey();
      const send = () =>
        request(app.getHttpServer())
          .patch(`/v1/users/00000000-0000-4000-8000-000000000000`)
          .set("Authorization", `Bearer ${token}`)
          .set("Idempotency-Key", key)
          .send({ name: "Nobody" });

      const first = await send();
      const retry = await send();

      expect(first.status).toBeGreaterThanOrEqual(HttpStatus.BAD_REQUEST);
      expect(retry.status).toBe(first.status);
      expect(retry.text).toBe(first.text);
      expect(retry.headers[IDEMPOTENCY_REPLAYED_HEADER.toLowerCase()]).toBe("true");
    });

    it("refuses a key reused for a different request with 422", async () => {
      const key = nextKey();
      await request(app.getHttpServer())
        .patch(`/v1/users/${userId}`)
        .set("Authorization", `Bearer ${token}`)
        .set("Idempotency-Key", key)
        .send({ name: "Ada" });

      const conflicting = await request(app.getHttpServer())
        .patch(`/v1/users/${userId}`)
        .set("Authorization", `Bearer ${token}`)
        .set("Idempotency-Key", key)
        .send({ name: "Someone else" });

      expect(conflicting.status).toBe(HttpStatus.UNPROCESSABLE_ENTITY);
      expect(conflicting.body.message).toMatch(/different request/i);
    });

    it("ignores the field order a client serialised its retry in", async () => {
      // Same two fields, opposite order. A client assembling its retry from a
      // map has no obligation to keep that stable, and 422-ing it would punish
      // the honest case the header exists to serve.
      const key = nextKey();
      const first = await request(app.getHttpServer())
        .patch(`/v1/users/${userId}/preferences`)
        .set("Authorization", `Bearer ${token}`)
        .set("Idempotency-Key", key)
        .set("Content-Type", "application/json")
        .send('{"theme":"dark","language":"fr"}');

      const retry = await request(app.getHttpServer())
        .patch(`/v1/users/${userId}/preferences`)
        .set("Authorization", `Bearer ${token}`)
        .set("Idempotency-Key", key)
        .set("Content-Type", "application/json")
        .send('{"language":"fr","theme":"dark"}');

      expect(first.status).toBe(HttpStatus.OK);
      expect(retry.status).toBe(HttpStatus.OK);
      expect(retry.headers[IDEMPOTENCY_REPLAYED_HEADER.toLowerCase()]).toBe("true");
    });

    it.each([
      ["blank", "   "],
      ["over-long", "k".repeat(256)],
    ])("rejects a %s key with 400", async (_why, key) => {
      const response = await request(app.getHttpServer())
        .patch(`/v1/users/${userId}`)
        .set("Authorization", `Bearer ${token}`)
        .set("Idempotency-Key", key)
        .send({ name: "Ada" });

      expect(response.status).toBe(HttpStatus.BAD_REQUEST);
    });

    it("ignores the header on a GET", async () => {
      const key = nextKey();
      const send = () =>
        request(app.getHttpServer())
          .get(`/v1/users/${userId}`)
          .set("Authorization", `Bearer ${token}`)
          .set("Idempotency-Key", key);

      await send();
      const second = await send();

      expect(second.status).toBe(HttpStatus.OK);
      expect(second.headers[IDEMPOTENCY_REPLAYED_HEADER.toLowerCase()]).toBeUndefined();
    });

    it("keeps one user's key out of another's namespace", async () => {
      // The security property. A global key namespace would let anyone replay
      // someone else's response — including the body — by guessing a key.
      const key = nextKey();
      await request(app.getHttpServer())
        .patch(`/v1/users/${userId}`)
        .set("Authorization", `Bearer ${token}`)
        .set("Idempotency-Key", key)
        .send({ name: "Ada" });

      const other = await request(app.getHttpServer()).post("/v1/auth/register").send({
        email: "idempotency-other@example.com",
        password: process.env["E2E_TEST_PASSWORD"],
        name: "Other User",
      });
      const otherToken = other.body.data.accessToken as string;

      const theirs = await request(app.getHttpServer())
        .patch(`/v1/users/${userId}`)
        .set("Authorization", `Bearer ${otherToken}`)
        .set("Idempotency-Key", key)
        .send({ name: "Ada" });

      // Not a replay of the first user's 200 — their own request, refused by
      // the ownership policy.
      expect(theirs.headers[IDEMPOTENCY_REPLAYED_HEADER.toLowerCase()]).toBeUndefined();
      expect(theirs.status).toBe(HttpStatus.FORBIDDEN);
    });

    it("runs the handler once when two copies of a request are sent at once", async () => {
      // Both go out before either comes back. Which of the two losing outcomes
      // the second gets — 409 because the first is still reserved, or a replay
      // because it had already finished — depends on scheduling that no test
      // can pin down, and pinning it would buy a flake rather than a
      // guarantee. What must hold either way is the invariant: exactly one of
      // them executed. The deterministic 409 path is covered in
      // `idempotency.interceptor.spec.ts`.
      const key = nextKey();
      const send = () =>
        request(app.getHttpServer())
          .patch(`/v1/users/${userId}`)
          .set("Authorization", `Bearer ${token}`)
          .set("Idempotency-Key", key)
          .send({ name: "Concurrent" });

      const responses = await Promise.all([send(), send()]);
      const replayHeader = IDEMPOTENCY_REPLAYED_HEADER.toLowerCase();
      const executed = responses.filter(
        (response) => response.status === HttpStatus.OK && !response.headers[replayHeader],
      );

      expect(executed).toHaveLength(1);
      const other = responses.find((response) => response !== executed[0]);
      expect([HttpStatus.OK, HttpStatus.CONFLICT]).toContain(other?.status);
      if (other?.status === HttpStatus.OK) {
        expect(other.headers[replayHeader]).toBe("true");
      }
    });
  });
});
