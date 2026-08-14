import type { INestApplication } from "@nestjs/common";
import { HttpStatus } from "@nestjs/common";
import request from "supertest";
import { createTestApp, type TestApp } from "./helpers/create-test-app";
import { StorageService } from "@/storage/storage.service";
import type { InMemoryPrismaService } from "./helpers/in-memory-prisma";

/**
 * The adapter choice, seen from outside.
 *
 * The unit suites prove each adapter behaves correctly and that the contract
 * holds across all three. This one proves the wiring: that `STORAGE_ADAPTER`
 * really reaches `StorageService` through Nest's injector, that an avatar
 * upload lands in whichever backend is selected, and that a capability the
 * active adapter lacks comes back as a real 501 through `AllExceptionsFilter`
 * rather than as an unhandled 500.
 *
 * `setup-env.ts` leaves `STORAGE_ADAPTER` unset, so the app runs on the
 * in-memory adapter — the default a clean clone gets.
 */
describe("Storage (e2e)", () => {
  const EMAIL = "storage-user@example.com";

  let app: INestApplication;
  let prisma: InMemoryPrismaService;
  let storage: StorageService;
  let token: string;
  let userId: string;

  beforeAll(async () => {
    const fixture: TestApp = await createTestApp();
    app = fixture.app;
    prisma = fixture.prisma;
    storage = app.get(StorageService);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    prisma.reset();

    const registered = await request(app.getHttpServer()).post("/v1/auth/register").send({
      email: EMAIL,
      password: process.env["E2E_TEST_PASSWORD"],
      name: "Storage User",
    });

    // `register` returns tokens only, so the id comes from the store — the same
    // route `users.e2e-spec.ts` takes.
    token = registered.body.data.accessToken as string;
    userId = [...prisma._users.values()].find((user) => user.email === EMAIL)?.id ?? "";
  });

  it("boots on the in-memory adapter when STORAGE_ADAPTER is unset", () => {
    expect(storage.adapterName).toBe("memory");
    expect(storage.supportsPresignedUrls).toBe(false);
  });

  // The avatar route is a conditional write. `*` is the right precondition for
  // a suite about where the bytes land: it asserts the user exists and nothing
  // about which version, which is all these tests depend on.

  describe("avatar upload", () => {
    it("stores the file in the selected backend and records its key", async () => {
      const response = await request(app.getHttpServer())
        .post(`/v1/users/${userId}/avatar`)
        .set("Authorization", `Bearer ${token}`)
        .set("If-Match", "*")
        .attach("file", Buffer.from("fake-jpeg-bytes"), {
          filename: "photo.jpg",
          contentType: "image/jpeg",
        });

      // 201: the avatar endpoint is a POST with no @HttpCode override.
      expect(response.status).toBe(HttpStatus.CREATED);

      const key = response.body.data.avatarUrl as string;
      expect(key).toMatch(new RegExp(`^avatars/${userId}/\\d+\\.jpg$`));

      // The point of the whole change: the controller named no backend, and
      // the bytes are in whichever one the environment selected.
      const stored = await storage.get(key);
      expect(stored.body.toString("utf8")).toBe("fake-jpeg-bytes");
      expect(stored.contentType).toBe("image/jpeg");
    });

    it("rejects a file type the endpoint does not allow before touching storage", async () => {
      const before = (await storage.list({ prefix: "avatars/" })).objects.length;

      const response = await request(app.getHttpServer())
        .post(`/v1/users/${userId}/avatar`)
        .set("Authorization", `Bearer ${token}`)
        .set("If-Match", "*")
        .attach("file", Buffer.from("#!/bin/sh"), {
          filename: "payload.sh",
          contentType: "application/x-sh",
        });

      expect(response.status).toBe(HttpStatus.BAD_REQUEST);
      expect((await storage.list({ prefix: "avatars/" })).objects).toHaveLength(before);
    });
  });

  describe("presigned URLs on an adapter that cannot sign", () => {
    it("answers 501, not 500, for an upload URL", async () => {
      // A filesystem and a `Map` have nothing to verify a signature with. The
      // status has to say "this deployment cannot do that" rather than look
      // like a crash — and it must come through the exception filter as
      // structured JSON like every other error.
      const response = await request(app.getHttpServer())
        .post("/v1/storage/presigned-upload")
        .set("Authorization", `Bearer ${token}`)
        .send({ key: "docs/a.txt", contentType: "text/plain" });

      expect(response.status).toBe(HttpStatus.NOT_IMPLEMENTED);
      expect(response.body).toMatchObject({
        statusCode: HttpStatus.NOT_IMPLEMENTED,
        path: "/v1/storage/presigned-upload",
      });
      expect(response.body.message).toContain("STORAGE_ADAPTER=s3");
    });

    it("answers 501 for a download URL too", async () => {
      const response = await request(app.getHttpServer())
        .post("/v1/storage/presigned-download")
        .set("Authorization", `Bearer ${token}`)
        .send({ key: "docs/a.txt" });

      expect(response.status).toBe(HttpStatus.NOT_IMPLEMENTED);
    });

    it("still rejects an invalid request body first", async () => {
      // Validation runs at the edge, so a malformed request is a 400 whichever
      // adapter is active — the 501 is about the deployment, not the input.
      const response = await request(app.getHttpServer())
        .post("/v1/storage/presigned-download")
        .set("Authorization", `Bearer ${token}`)
        .send({ key: "" });

      expect(response.status).toBe(HttpStatus.BAD_REQUEST);
    });

    it("requires authentication before reporting the capability", async () => {
      // Otherwise the endpoint would leak which storage backend a deployment
      // runs on to anyone who asked.
      const response = await request(app.getHttpServer())
        .post("/v1/storage/presigned-download")
        .send({ key: "docs/a.txt" });

      expect(response.status).toBe(HttpStatus.UNAUTHORIZED);
    });
  });
});
