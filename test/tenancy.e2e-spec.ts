import { HttpStatus, type INestApplication } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import request from "supertest";
import { TENANT_HEADER, tenantSetting } from "@/tenancy";
import type { JwtPayload } from "@/auth/strategies/jwt.strategy";
import { createTestApp, type TestApp } from "./helpers/create-test-app";
import type { InMemoryPrismaService } from "./helpers/in-memory-prisma";

/**
 * Tenancy as a request sees it: which tenant a request is resolved to, what the
 * token it is given says, and what happens when the two disagree.
 *
 * What this suite deliberately does not assert is isolation. That is a property of
 * the policies in `20261002000000_add_multi_tenancy`, this suite runs against
 * `InMemoryPrismaService`, and a double that filtered by tenant would be reporting
 * that Postgres works while never having asked it —
 * `test/tenant-isolation.db-spec.ts` asks it, as a role the policies apply to.
 *
 * `TENANCY_BASE_DOMAIN` is unset here, because `ConfigModule` validates the
 * environment while `app.module.ts` is imported and no `beforeAll` can change it
 * afterwards (see `test/helpers/setup-env.ts`). Host-based resolution is covered in
 * `src/tenancy/tenant.resolver.spec.ts`, over the same function this application
 * calls.
 */
describe("Multi-tenancy (e2e)", () => {
  let app: INestApplication;
  let prisma: InMemoryPrismaService;
  let jwt: JwtService;

  const PASSWORD = process.env["E2E_TEST_PASSWORD"]!;

  beforeAll(async () => {
    const fixture: TestApp = await createTestApp();
    app = fixture.app;
    prisma = fixture.prisma;
    jwt = app.get(JwtService);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    prisma.reset();
  });

  const http = () => request(app.getHttpServer());

  const claimsOf = (token: string): JwtPayload => jwt.verify<JwtPayload>(token);

  async function registerIn(
    tenant: string | undefined,
    email: string,
  ): Promise<{ status: number; token: string }> {
    const call = http().post("/v1/auth/register");
    if (tenant !== undefined) call.set(TENANT_HEADER, tenant);
    const response = await call.send({ email, password: PASSWORD, name: "Tenant User" });
    return { status: response.status, token: response.body?.data?.accessToken as string };
  }

  describe("the tenant a token is issued for", () => {
    it("is the one the request named", async () => {
      const { status, token } = await registerIn("acme", "acme-user@example.test");

      expect(status).toBe(HttpStatus.CREATED);
      expect(claimsOf(token).tid).toBe("acme");
    });

    it("is the default tenant when the request named none", async () => {
      // What a single-tenant deployment is, and why a clean clone needs no tenancy
      // configuration: every request resolves to the one tenant the migration
      // inserted.
      const { token } = await registerIn(undefined, "default-user@example.test");

      expect(claimsOf(token).tid).toBe("default");
    });

    it("is carried through a login, not just a registration", async () => {
      await registerIn("acme", "login@example.test");

      const response = await http()
        .post("/v1/auth/login")
        .set(TENANT_HEADER, "acme")
        .send({ email: "login@example.test", password: PASSWORD });

      expect(response.status).toBe(HttpStatus.OK);
      expect(claimsOf(response.body.data.accessToken as string).tid).toBe("acme");
    });

    it("is carried through a refresh, so a rotated token is still tenant-scoped", async () => {
      const registration = await http()
        .post("/v1/auth/register")
        .set(TENANT_HEADER, "acme")
        .send({ email: "rotate@example.test", password: PASSWORD, name: "Tenant User" });

      const response = await http()
        .post("/v1/auth/refresh")
        .set(TENANT_HEADER, "acme")
        .send({ refreshToken: registration.body.data.refreshToken as string });

      expect(response.status).toBe(HttpStatus.OK);
      expect(claimsOf(response.body.data.accessToken as string).tid).toBe("acme");
    });
  });

  // `GET /v1/auth/me` throughout: it is authenticated, it reads nothing out of the
  // database, and it is therefore the one route where a 200 means "the token was
  // accepted in this tenant" and nothing else.
  describe("what the application tells the database", () => {
    it("names the tenant in the transaction that writes the row", async () => {
      // The fake records the statement rather than honouring it, so this asserts
      // the one thing an in-memory double can honestly assert about tenancy: that
      // the application asked, with the tenant the request resolved to, before the
      // write. Whether Postgres then hides another tenant's rows is
      // test/tenant-isolation.db-spec.ts's question.
      await registerIn("acme", "setting@example.test");

      expect(prisma.tenantSettings).toContainEqual(tenantSetting("acme"));
    });

    it("asks for nothing on a request that writes nothing", async () => {
      await http().get("/v1/auth/me");

      expect(prisma.tenantSettings).toHaveLength(0);
    });
  });

  describe("a token used in another tenant", () => {
    it("is refused with 403 rather than quietly reading nothing", async () => {
      // Under the policies this request would succeed and return nothing: the user
      // id in the token names a row `globex` cannot see. A 403 naming both tenants
      // is the difference between a minute and an afternoon of diagnosis.
      const { token } = await registerIn("acme", "cross@example.test");

      const response = await http()
        .get("/v1/auth/me")
        .set(TENANT_HEADER, "globex")
        .set("Authorization", `Bearer ${token}`);

      expect(response.status).toBe(HttpStatus.FORBIDDEN);
    });

    it("works in the tenant it was issued for", async () => {
      const { token } = await registerIn("acme", "same@example.test");

      const response = await http()
        .get("/v1/auth/me")
        .set(TENANT_HEADER, "acme")
        .set("Authorization", `Bearer ${token}`);

      expect(response.status).toBe(HttpStatus.OK);
    });

    it("is refused when the request names no tenant and the token names one", async () => {
      const { token } = await registerIn("acme", "unnamed@example.test");

      const response = await http().get("/v1/auth/me").set("Authorization", `Bearer ${token}`);

      expect(response.status).toBe(HttpStatus.FORBIDDEN);
    });
  });

  describe("a token with no tenant claim", () => {
    it("is refused, because nothing should choose a tenant for a credential", async () => {
      // The shape a token minted before tenancy existed has. It verifies perfectly
      // — this one is signed with the running key — and names no customer, so it is
      // 401 and a refresh rather than a guess. Access tokens live fifteen minutes,
      // so the upgrade costs one refresh per client.
      const legacy = jwt.sign({ sub: "user-1", email: "legacy@example.test", role: "USER" });

      const response = await http().get("/v1/auth/me").set("Authorization", `Bearer ${legacy}`);

      expect(response.status).toBe(HttpStatus.UNAUTHORIZED);
    });
  });

  describe("a malformed tenant header", () => {
    it("is a 400 in this API's own error envelope", async () => {
      // The middleware cannot throw this — an exception there reaches Express's own
      // handler, which answers with an HTML stack trace and never consults
      // `AllExceptionsFilter`. `TenantGuard` rethrows it from inside the pipeline
      // instead, which is what keeps the shape.
      const response = await http().post("/v1/auth/login").set(TENANT_HEADER, "Acme Corp").send({
        email: "whoever@example.test",
        password: PASSWORD,
      });

      expect(response.status).toBe(HttpStatus.BAD_REQUEST);
      expect(response.body).toMatchObject({
        statusCode: HttpStatus.BAD_REQUEST,
        error: "Bad Request",
        message: expect.stringContaining("tenant id"),
        path: "/v1/auth/login",
        timestamp: expect.any(String),
      });
    });

    it("stops the request before it authenticates anybody", async () => {
      await registerIn("acme", "untouched@example.test");

      const response = await http()
        .post("/v1/auth/login")
        .set(TENANT_HEADER, "Acme Corp")
        .send({ email: "untouched@example.test", password: PASSWORD });

      expect(response.status).toBe(HttpStatus.BAD_REQUEST);
      expect(response.body.data).toBeUndefined();
    });
  });
});
