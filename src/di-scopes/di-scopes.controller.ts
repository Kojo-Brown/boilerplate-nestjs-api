import { Controller, Get, Req } from "@nestjs/common";
import { ApiOkResponse, ApiOperation, ApiTags } from "@nestjs/swagger";
import type { Request } from "express";
import { ApiEnvelopeOf } from "@/common/dto/response-envelope.dto";
import { AuditTrailService } from "./audit-trail.service";
import { ScopeReportDto, ScopedInstanceDto } from "./dto/scope-report.dto";
import { FeatureFlagCache } from "./feature-flag-cache.service";
import { InstantiationLedger } from "./instantiation-ledger.service";
import { RequestContextResolver } from "./request-context.resolver";
import { RequestContextService } from "./request-context.service";
import { ScopedLogger } from "./scoped-logger.service";
import { SingletonAuditTrail } from "./singleton-audit-trail.service";

/**
 * The three scopes, observable over HTTP.
 *
 * ```
 * curl -s localhost:4000/v1/di-scopes | jq '.data | {singleton, requestScoped, transient}'
 * ```
 *
 * Call it twice. `singleton.instanceId` is the same both times, `requestScoped`
 * and `inheritedRequestScope` are not, and `transient` follows its host: the
 * one in `FeatureFlagCache` was built at boot and never again, the one in this
 * controller is rebuilt per request because *this controller* is.
 *
 * This controller is itself the clearest evidence of the trap. It declares no
 * scope. It is rebuilt per request anyway — along with its whole dependency
 * subtree — because one of the six providers below is request-scoped, and that
 * is enough. Nest reports it at boot through {@link ScopeAudit}.
 *
 * The endpoint is unauthenticated because it discloses nothing: class names
 * from this module, which are public in the boilerplate, and counters. It
 * reaches no database and allocates nothing unbounded — the ledger keeps
 * counts plus a fixed window of ids, and both audit buffers are bounded. It is
 * still a teaching endpoint: delete `src/di-scopes` and its line in
 * `AppModule` when you start building on this boilerplate, and nothing else
 * changes.
 */
@ApiTags("di-scopes")
@Controller("di-scopes")
export class DiScopesController {
  constructor(
    private readonly flags: FeatureFlagCache,
    private readonly context: RequestContextService,
    private readonly bubbledTrail: AuditTrailService,
    private readonly singletonTrail: SingletonAuditTrail,
    private readonly resolver: RequestContextResolver,
    private readonly ledger: InstantiationLedger,
    private readonly logger: ScopedLogger,
  ) {}

  @Get()
  @ApiOperation({
    summary: "Show what each provider scope does to instance lifetime",
    description:
      "Returns the identity of one DEFAULT-, one REQUEST- and one TRANSIENT-scoped provider, " +
      "plus a provider that inherited request scope without declaring it. Call it twice and " +
      "compare the instance ids. See docs/di-scopes.md.",
  })
  @ApiOkResponse({ type: ApiEnvelopeOf(ScopeReportDto) })
  async report(@Req() request: Request): Promise<ScopeReportDto> {
    this.bubbledTrail.record("di-scopes.report");
    this.singletonTrail.record("di-scopes.report", this.context.correlationId);

    // Evaluated on every request against the same singleton, so the memo is
    // warm from the second request onwards — the thing this provider would
    // lose if it ever inherited request scope.
    this.flags.isEnabled("search.semantic", this.context.correlationId);

    // The escape hatch, exercised on the real path: a singleton reaching the
    // request-scoped provider for *this* request. The id below is the id in
    // `requestScoped`, not a second instance carrying the same data.
    const resolved = await this.resolver.forRequest(request as unknown as Record<string, unknown>);

    return {
      correlationId: this.context.correlationId,
      singleton: this.describe(
        this.flags.instanceId,
        "DEFAULT",
        FeatureFlagCache.name,
        "Built once during app.init(). Its flag table and memo survive every request.",
      ),
      requestScoped: this.describe(
        this.context.instanceId,
        "REQUEST",
        RequestContextService.name,
        "Declared Scope.REQUEST: one instance per request, holding this request's data.",
      ),
      transient: this.describe(
        this.logger.instanceId,
        "TRANSIENT",
        ScopedLogger.name,
        "One instance per injection site. This one belongs to the controller, so it is " +
          "rebuilt whenever the controller is.",
      ),
      inheritedRequestScope: this.describe(
        this.bubbledTrail.instanceId,
        "DEFAULT",
        AuditTrailService.name,
        "Declared @Injectable() with no scope, rebuilt per request because it injects " +
          "RequestContextService.",
      ),
      bubbledAuditEntries: this.bubbledTrail.entries().length,
      singletonAuditEntries: this.singletonTrail.entries().length,
      transientLoggerHosts: [this.flags.loggerHost(), this.context.loggerHost(), this.logger.host],
      resolvedViaModuleRef: resolved.instanceId,
    };
  }

  private describe(
    instanceId: string,
    scope: ScopedInstanceDto["scope"],
    provider: string,
    note: string,
  ): ScopedInstanceDto {
    return { instanceId, scope, constructions: this.ledger.countFor(provider), note };
  }
}
