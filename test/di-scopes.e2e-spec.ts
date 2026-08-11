import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { createTestApp, type TestApp } from "./helpers/create-test-app";
import { ScopeAudit } from "@/di-scopes";
import type { ScopeReportDto } from "@/di-scopes/dto/scope-report.dto";
import { CORRELATION_ID_HEADER } from "@/common/interceptors/logging.interceptor";

/**
 * The three scopes over a real router.
 *
 * `scope-lifetimes.spec.ts` proves the container semantics by resolving through
 * context ids by hand. This suite proves the two things that only the router
 * can: that the ids it attaches to a request are what make the request-scoped
 * instance shared within one request and distinct between two, and that the
 * demo module is actually wired into `AppModule` rather than merely correct in
 * isolation.
 *
 * It also holds a line for the rest of the application: the audit below fails
 * if any provider outside `src/di-scopes` starts being rebuilt per request.
 */
describe("DI scopes (e2e)", () => {
  let app: INestApplication;

  const report = async (correlationId?: string): Promise<ScopeReportDto> => {
    const call = request(app.getHttpServer()).get("/v1/di-scopes");
    if (correlationId) call.set(CORRELATION_ID_HEADER, correlationId);
    const res = await call.expect(200);
    return res.body.data as ScopeReportDto;
  };

  beforeAll(async () => {
    const fixture: TestApp = await createTestApp();
    app = fixture.app;
  });

  afterAll(async () => {
    await app.close();
  });

  it("keeps one singleton instance across requests and builds a new request-scoped one each time", async () => {
    const first = await report();
    const second = await report();

    expect(first.singleton.instanceId).toBe(second.singleton.instanceId);
    expect(first.singleton.constructions).toBe(1);

    expect(first.requestScoped.instanceId).not.toBe(second.requestScoped.instanceId);
    expect(second.requestScoped.constructions).toBeGreaterThan(
      first.requestScoped.constructions - 1,
    );
  });

  it("gives the request-scoped provider the correlation id of its own request", async () => {
    const first = await report("corr-e2e-1");
    const second = await report("corr-e2e-2");

    expect(first.correlationId).toBe("corr-e2e-1");
    expect(second.correlationId).toBe("corr-e2e-2");
  });

  it("resolves the request's own instance from a singleton, rather than a second one", async () => {
    // The claim `RequestContextResolver` exists to make, and the one only a
    // real request can test: the context id it keys off is attached by the
    // router. Same id, so the same object the controller was injected with —
    // not a copy carrying the same data.
    const body = await report("corr-e2e-3");

    expect(body.resolvedViaModuleRef).toBe(body.requestScoped.instanceId);
  });

  it("rebuilds the provider that inherited request scope, and loses its buffer with it", async () => {
    const first = await report();
    const second = await report();

    expect(first.inheritedRequestScope.instanceId).not.toBe(
      second.inheritedRequestScope.instanceId,
    );
    // One entry per request, every request, forever: the buffer never sees
    // more than the request that built it.
    expect(first.bubbledAuditEntries).toBe(1);
    expect(second.bubbledAuditEntries).toBe(1);
    // The same audit trail kept as a singleton accumulates instead.
    expect(second.singletonAuditEntries).toBe(first.singletonAuditEntries + 1);
  });

  it("names each transient logger after the class it was injected into", async () => {
    const body = await report();

    expect(body.transientLoggerHosts).toEqual([
      "FeatureFlagCache",
      "RequestContextService",
      "DiScopesController",
    ]);
  });

  it("keeps request scope contained to the demo module", () => {
    // A regression guard for the whole application, not just this module.
    // Injecting a request-scoped provider into, say, `UsersService` would
    // silently convert it and everything above it; this is what would notice.
    const audit = app.get(ScopeAudit).audit();

    expect(audit.requestScoped.map((entry) => entry.name)).toEqual([
      "AuditTrailService",
      "DiScopesController",
      "RequestContextService",
    ]);
  });

  it("finds no transient provider outside the demo module beyond the health indicators", () => {
    // `@nestjs/terminus` declares its indicators transient, so they are in the
    // report and always will be. Naming them is the point: an unexplained
    // entry appearing here is a change somebody made, and this is where it
    // gets noticed. Transient is cheap — one instance per injection site, not
    // per request — so this is a completeness check, not a performance one.
    const audit = app.get(ScopeAudit).audit();

    expect(audit.transient.map((entry) => entry.name)).toEqual([
      "GRPCHealthIndicator",
      "HttpHealthIndicator",
      "MicroserviceHealthIndicator",
      "MikroOrmHealthIndicator",
      "MongooseHealthIndicator",
      "ScopedLogger",
      "SequelizeHealthIndicator",
      "TypeOrmHealthIndicator",
    ]);
  });
});
