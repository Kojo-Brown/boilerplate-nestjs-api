import { Module } from "@nestjs/common";
import { DiscoveryModule } from "@nestjs/core";
import { AuditTrailService } from "./audit-trail.service";
import { DiScopesController } from "./di-scopes.controller";
import { FeatureFlagCache } from "./feature-flag-cache.service";
import { InstantiationLedger } from "./instantiation-ledger.service";
import { RequestContextResolver } from "./request-context.resolver";
import { RequestContextService } from "./request-context.service";
import { ScopeAudit } from "./scope-audit.service";
import { ScopedLogger } from "./scoped-logger.service";
import { SingletonAuditTrail } from "./singleton-audit-trail.service";

/**
 * The provider-scope demonstration, plus the audit that keeps it honest.
 *
 * Two different things live here on purpose. Everything except {@link ScopeAudit}
 * is a teaching aid: delete the directory and its line in `AppModule` and the
 * application is unchanged. {@link ScopeAudit} is not — it reports at boot
 * which components the container rebuilds per request, which is worth keeping
 * once the rest is gone.
 *
 * Nothing is exported. A consumer outside this module injecting
 * {@link RequestContextService} would inherit its scope, which is the mistake
 * the module exists to describe; write your own request-scoped provider, or
 * reach this one through {@link RequestContextResolver}, which is exported
 * precisely because it does *not* propagate scope.
 *
 * `FEATURE_FLAGS` is deliberately unbound: {@link FeatureFlagCache} injects it
 * `@Optional()` and falls back to `DEFAULT_FLAGS`, so the token only has to
 * exist in a deployment that overrides the table.
 */
@Module({
  imports: [DiscoveryModule],
  controllers: [DiScopesController],
  providers: [
    InstantiationLedger,
    ScopedLogger,
    FeatureFlagCache,
    RequestContextService,
    AuditTrailService,
    SingletonAuditTrail,
    RequestContextResolver,
    ScopeAudit,
  ],
  exports: [RequestContextResolver, ScopeAudit],
})
export class DiScopesModule {}
