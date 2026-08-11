import { Inject, Injectable, Logger, Module, Scope } from "@nestjs/common";
import { DiscoveryModule } from "@nestjs/core";
import { Test } from "@nestjs/testing";
import type { TestingModule } from "@nestjs/testing";
import { AuditTrailService } from "./audit-trail.service";
import { DiScopesController } from "./di-scopes.controller";
import { DiScopesModule } from "./di-scopes.module";
import { RequestContextService } from "./request-context.service";
import { ScopeAudit } from "./scope-audit.service";
import type { ScopeAuditReport, ScopedComponent } from "./scope-audit.service";
import { ScopedLogger } from "./scoped-logger.service";

/** Four providers, one of them request-scoped, and a three-hop chain up to a controller. */
@Injectable({ scope: Scope.REQUEST })
class TenantContext {}

@Injectable()
class TenantRepository {
  constructor(readonly tenant: TenantContext) {}
}

@Injectable()
class ReportBuilder {
  constructor(readonly repository: TenantRepository) {}
}

@Injectable()
class UnrelatedSingleton {}

@Module({
  imports: [DiscoveryModule],
  providers: [ScopeAudit, TenantContext, TenantRepository, ReportBuilder, UnrelatedSingleton],
})
class ChainModule {}

@Injectable()
class PlainService {}

@Module({ imports: [DiscoveryModule], providers: [ScopeAudit, PlainService] })
class StaticModule {}

/** A request-scoped provider bound to a symbol token rather than a class. */
const TENANT_TOKEN = Symbol("TENANT_TOKEN");

@Injectable()
class TokenConsumer {
  constructor(@Inject(TENANT_TOKEN) readonly tenant: object) {}
}

@Module({
  imports: [DiscoveryModule],
  providers: [
    ScopeAudit,
    { provide: TENANT_TOKEN, scope: Scope.REQUEST, useFactory: (): object => ({}) },
    TokenConsumer,
  ],
})
class TokenModule {}

describe("ScopeAudit", () => {
  const byName = (report: readonly ScopedComponent[], name: string): ScopedComponent | undefined =>
    report.find((entry) => entry.name === name);

  async function auditOf(module: unknown): Promise<{
    report: ScopeAuditReport;
    moduleRef: TestingModule;
  }> {
    const moduleRef = await Test.createTestingModule({
      imports: [module as never],
    }).compile();
    await moduleRef.init();
    return { report: moduleRef.get(ScopeAudit).audit(), moduleRef };
  }

  describe("against the demo module", () => {
    let report: ScopeAuditReport;
    let moduleRef: TestingModule;

    beforeAll(async () => {
      ({ report, moduleRef } = await auditOf(DiScopesModule));
    });

    afterAll(async () => {
      await moduleRef.close();
    });

    it("separates a declared scope from an inherited one", () => {
      expect(byName(report.requestScoped, RequestContextService.name)).toEqual({
        name: RequestContextService.name,
        kind: "provider",
        declaredScope: "REQUEST",
        reason: "declared",
        causedBy: [],
      });

      expect(byName(report.requestScoped, AuditTrailService.name)).toEqual({
        name: AuditTrailService.name,
        kind: "provider",
        declaredScope: "DEFAULT",
        reason: "inherited",
        causedBy: [AuditTrailService.name, RequestContextService.name],
      });
    });

    it("catches the controller the scope propagated up to", () => {
      expect(byName(report.requestScoped, DiScopesController.name)).toMatchObject({
        kind: "controller",
        reason: "inherited",
      });
    });

    it("lists transient providers separately from request-scoped ones", () => {
      expect(report.transient.map((entry) => entry.name)).toEqual([ScopedLogger.name]);
      expect(byName(report.requestScoped, ScopedLogger.name)).toBeUndefined();
    });

    it("does not report the framework's own REQUEST and INQUIRER providers", () => {
      const names = [...report.requestScoped, ...report.transient].map((entry) => entry.name);

      expect(names).not.toContain("REQUEST");
      expect(names).not.toContain("INQUIRER");
    });

    it("leaves singletons out of the report entirely", () => {
      const names = [...report.requestScoped, ...report.transient].map((entry) => entry.name);

      expect(names).not.toContain("FeatureFlagCache");
      expect(names).not.toContain("InstantiationLedger");
      expect(names).not.toContain("RequestContextResolver");
    });
  });

  describe("attribution", () => {
    it("names the whole chain from the consumer to the cause", async () => {
      const { report, moduleRef } = await auditOf(ChainModule);

      expect(byName(report.requestScoped, ReportBuilder.name)?.causedBy).toEqual([
        ReportBuilder.name,
        TenantRepository.name,
        TenantContext.name,
      ]);

      await moduleRef.close();
    });

    it("names a provider bound to a symbol token, rather than printing an object", async () => {
      const { report, moduleRef } = await auditOf(TokenModule);

      expect(report.requestScoped.map((entry) => entry.name)).toEqual([
        "Symbol(TENANT_TOKEN)",
        TokenConsumer.name,
      ]);
      expect(byName(report.requestScoped, TokenConsumer.name)?.causedBy).toEqual([
        TokenConsumer.name,
        "Symbol(TENANT_TOKEN)",
      ]);

      await moduleRef.close();
    });

    it("leaves a provider that depends on nothing scoped alone", async () => {
      const { report, moduleRef } = await auditOf(ChainModule);

      expect(byName(report.requestScoped, UnrelatedSingleton.name)).toBeUndefined();

      await moduleRef.close();
    });
  });

  describe("reporting at boot", () => {
    it("warns once per component that inherited a scope it never declared", async () => {
      const warn = jest.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
      const log = jest.spyOn(Logger.prototype, "log").mockImplementation(() => undefined);

      const moduleRef = await Test.createTestingModule({ imports: [ChainModule] }).compile();
      await moduleRef.init();

      const warned = warn.mock.calls.map(([message]) => String(message));
      expect(warned).toHaveLength(2);
      expect(warned).toContainEqual(
        expect.stringContaining("ReportBuilder is rebuilt per request but never asked to be"),
      );
      expect(warned).toContainEqual(
        expect.stringContaining(`${TenantRepository.name} → ${TenantContext.name}`),
      );
      // The provider that declared `Scope.REQUEST` chose it; warning about a
      // deliberate decision on every boot is how a log gets ignored.
      expect(warned.some((message) => message.startsWith(TenantContext.name))).toBe(false);
      expect(log).toHaveBeenCalledWith(expect.stringContaining("rebuilt per request"));

      await moduleRef.close();
      warn.mockRestore();
      log.mockRestore();
    });

    it("says so plainly when the whole graph is built once", async () => {
      const log = jest.spyOn(Logger.prototype, "log").mockImplementation(() => undefined);
      const warn = jest.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);

      const moduleRef = await Test.createTestingModule({ imports: [StaticModule] }).compile();
      await moduleRef.init();

      expect(log).toHaveBeenCalledWith(
        "No request-scoped components: the whole graph is built once.",
      );
      expect(warn).not.toHaveBeenCalled();

      await moduleRef.close();
      log.mockRestore();
      warn.mockRestore();
    });
  });
});
