export { AuditTrailService } from "./audit-trail.service";
export { DiScopesController } from "./di-scopes.controller";
export { DiScopesModule } from "./di-scopes.module";
export { DEFAULT_FLAGS, FEATURE_FLAGS, FeatureFlagCache } from "./feature-flag-cache.service";
export { InstantiationLedger, RECENT_INSTANCE_IDS } from "./instantiation-ledger.service";
export { RequestContextResolver } from "./request-context.resolver";
export { RequestContextService } from "./request-context.service";
export { ScopeAudit } from "./scope-audit.service";
export { ScopedLogger } from "./scoped-logger.service";
export { AUDIT_BUFFER_LIMIT, SingletonAuditTrail } from "./singleton-audit-trail.service";

export type { AuditEntry } from "./audit-trail.service";
export type { FlagRollout } from "./feature-flag-cache.service";
export type { LedgerEntry } from "./instantiation-ledger.service";
export type { ContextCarrier } from "./request-context.resolver";
export type { RequestFacts } from "./request-context.service";
export type { ScopeAuditReport, ScopeName, ScopedComponent } from "./scope-audit.service";
