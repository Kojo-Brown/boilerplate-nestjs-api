import { Global, Module } from "@nestjs/common";
import { AuditChainVerifier } from "./audit-chain.verifier";
import { AuditLog } from "./audit-log.service";
import { AuditLogController } from "./audit-log.controller";
import { PrismaAuditLogStore } from "./prisma-audit-log.store";
import { AUDIT_LOG_STORE } from "./ports";

/**
 * Wires the audit log.
 *
 * `@Global` for the reason `OutboxModule` is: anything that does something
 * worth recording records it, and making every such module import this would
 * reintroduce the wiring a cross-cutting concern exists to remove.
 *
 * The store is bound by token so the e2e suite — which runs the whole
 * application without a database — can substitute the in-memory double, exactly
 * as it does for the outbox and saga stores. The double is a real
 * implementation of the chain rather than a recorder, so what those specs
 * assert on is what production writes.
 */
@Global()
@Module({
  controllers: [AuditLogController],
  providers: [
    { provide: AUDIT_LOG_STORE, useClass: PrismaAuditLogStore },
    AuditLog,
    AuditChainVerifier,
  ],
  exports: [AuditLog, AuditChainVerifier, AUDIT_LOG_STORE],
})
export class AuditModule {}
