import type { INestApplication } from "@nestjs/common";
import { Role } from "@prisma/client";
import request from "supertest";
import { AuditChainVerifier, GENESIS_HASH } from "@/audit";
import { createTestApp, type TestApp } from "./helpers/create-test-app";
import type { InMemoryAuditLogStore } from "@/test-utils/in-memory-audit-log.store";
import type { InMemoryPrismaService } from "./helpers/in-memory-prisma";

/**
 * The audit log end to end: written by the operations that are audited, read
 * back through the endpoint, verified as a chain.
 *
 * The store here is the in-memory double, so the append-only trigger and the
 * advisory lock are not in play — `test/audit-log-store.db-spec.ts` is where
 * those are asserted, against a real server. What this suite covers is the part
 * that only exists once the whole application is assembled: that the entries
 * are written at all, by the right operations, with the right actor, and that
 * what comes back over HTTP survives JSON.
 */
describe("Audit log (e2e)", () => {
  let app: INestApplication;
  let prisma: InMemoryPrismaService;
  let auditLog: InMemoryAuditLogStore;

  let userToken: string;
  let adminToken: string;
  let userId: string;
  let adminId: string;

  beforeAll(async () => {
    const fixture: TestApp = await createTestApp();
    app = fixture.app;
    prisma = fixture.prisma;
    auditLog = fixture.auditLog;
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    prisma.reset();
    auditLog.reset();

    const userRes = await request(app.getHttpServer()).post("/v1/auth/register").send({
      email: "user@example.com",
      password: process.env["E2E_TEST_PASSWORD"]!,
      name: "Regular User",
    });
    userToken = userRes.body.data.accessToken as string;
    userId = [...prisma._users.values()].find((u) => u.email === "user@example.com")?.id ?? "";

    await request(app.getHttpServer()).post("/v1/auth/register").send({
      email: "admin@example.com",
      password: process.env["E2E_TEST_PASSWORD"]!,
      name: "Admin User",
    });
    adminId = [...prisma._users.values()].find((u) => u.email === "admin@example.com")?.id ?? "";
    await prisma.user.update({ where: { id: adminId }, data: { role: Role.ADMIN } });

    const adminLogin = await request(app.getHttpServer())
      .post("/v1/auth/login")
      .send({ email: "admin@example.com", password: process.env["E2E_TEST_PASSWORD"]! });
    adminToken = adminLogin.body.data.accessToken as string;
  });

  const list = (token: string, query = "") =>
    request(app.getHttpServer())
      .get(`/v1/audit-log${query}`)
      .set("Authorization", `Bearer ${token}`);

  const verify = (token: string) =>
    request(app.getHttpServer())
      .get("/v1/audit-log/verify")
      .set("Authorization", `Bearer ${token}`);

  describe("what gets recorded", () => {
    it("records a registration as the account itself, with no request of its own", async () => {
      // The two registrations in `beforeEach` are the whole chain so far: the
      // audit log is written by the operations that are audited, not by
      // anything a client can call.
      const res = await list(adminToken);

      expect(res.status).toBe(200);
      expect(res.body.data).toEqual([
        expect.objectContaining({
          seq: "1",
          action: "user.registered",
          resourceType: "user",
          resourceId: userId,
          details: { email: "user@example.com", provider: null },
          actorId: userId,
          actorRole: "USER",
          prevHash: GENESIS_HASH,
        }),
        expect.objectContaining({ seq: "2", resourceId: adminId }),
      ]);
    });

    it("records a deletion against the admin who performed it", async () => {
      const user = await request(app.getHttpServer())
        .get(`/v1/users/${userId}`)
        .set("Authorization", `Bearer ${adminToken}`);

      await request(app.getHttpServer())
        .delete(`/v1/users/${userId}`)
        .set("Authorization", `Bearer ${adminToken}`)
        .set("If-Match", user.headers["etag"] as string)
        .expect(204);

      const res = await list(adminToken, "?afterSeq=2");
      expect(res.body.data).toEqual([
        expect.objectContaining({
          seq: "3",
          action: "user.deleted",
          resourceId: userId,
          details: { email: "user@example.com" },
          // The admin, not the deleted account: "who did this" is the question
          // the entry exists to answer, and it outlives the row it describes.
          actorId: adminId,
          actorRole: "ADMIN",
        }),
      ]);
    });

    it("leaves the chain unextended by an operation that was refused", async () => {
      // A stale `If-Match` is refused before anything is written. The delete
      // did not happen, so nothing may claim it did.
      await request(app.getHttpServer())
        .delete(`/v1/users/${userId}`)
        .set("Authorization", `Bearer ${adminToken}`)
        .set("If-Match", '"999"')
        .expect(412);

      const res = await list(adminToken);
      expect(res.body.data).toHaveLength(2);
    });
  });

  describe("reading it back", () => {
    it("pages forward from a cursor, in chain order", async () => {
      const first = await list(adminToken, "?limit=1");
      const second = await list(adminToken, `?afterSeq=${first.body.data[0].seq}&limit=1`);

      expect(first.body.data.map((entry: { seq: string }) => entry.seq)).toEqual(["1"]);
      expect(second.body.data.map((entry: { seq: string }) => entry.seq)).toEqual(["2"]);
      expect(second.body.data[0].prevHash).toBe(first.body.data[0].hash);
    });

    it("renders seq as a string, so a 64-bit position survives JSON", async () => {
      const res = await list(adminToken, "?limit=1");

      expect(typeof res.body.data[0].seq).toBe("string");
    });

    it("rejects a cursor that is not a whole number", async () => {
      await list(adminToken, "?afterSeq=-1").expect(400);
      await list(adminToken, "?afterSeq=nonsense").expect(400);
    });

    it("rejects a page larger than the maximum", async () => {
      await list(adminToken, "?limit=201").expect(400);
    });

    it("is admin-only, because it is more sensitive than what it describes", async () => {
      // It carries the address of every deleted account and the identity of
      // everyone who acted.
      await list(userToken).expect(403);
      await request(app.getHttpServer()).get("/v1/audit-log").expect(401);
    });

    it("offers no way to write an entry", async () => {
      // An endpoint that appended would be a way to put a statement into the
      // record with no action behind it.
      await request(app.getHttpServer())
        .post("/v1/audit-log")
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ action: "user.deleted" })
        .expect(404);
    });
  });

  describe("verifying it", () => {
    it("reports the chain the application actually wrote as intact", async () => {
      const res = await verify(adminToken);

      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({
        intact: true,
        checked: 2,
        firstSeq: "1",
        lastSeq: "2",
        breach: null,
      });
      expect(res.body.data.headHash).toBe(auditLog.entries.at(-1)!.hash);
    });

    it("catches an entry edited behind the application's back", async () => {
      // Reaching into the double is the only way to tamper here; in Postgres the
      // same edit is refused by a trigger, and `test/audit-log-store.db-spec.ts`
      // covers the case where somebody switches that off.
      auditLog.entries[0] = {
        ...auditLog.entries[0]!,
        details: { email: "rewritten@example.com", provider: null },
      };

      const res = await verify(adminToken);

      expect(res.body.data).toMatchObject({
        intact: false,
        checked: 0,
        breach: { seq: "1", kind: "forged-hash" },
      });
    });

    it("is admin-only too", async () => {
      await verify(userToken).expect(403);
    });

    it("verifies through the same chain the container handed the application", async () => {
      // Guards the wiring rather than the algorithm: a verifier resolved
      // against a different store instance would report an empty, intact chain
      // no matter what the application had written.
      const verifier = app.get(AuditChainVerifier);

      await expect(verifier.verify()).resolves.toMatchObject({ checked: 2, intact: true });
    });
  });
});
