import { Inject, Injectable } from "@nestjs/common";
import type { TransactionContext } from "@/common/prisma/transaction.port";
import type {
  AuditActionDetails,
  AuditActionName,
  AuditContext,
  AuditEntry,
  NewAuditEntry,
} from "./audit-entry";
import { AUDIT_LOG_STORE, type AuditLogStore } from "./ports";

/**
 * Records what somebody did, durably and tamper-evidently, as part of the
 * caller's transaction.
 *
 * The signature is deliberately the same shape as `TransactionalOutbox.stage`,
 * because the placement rule is the same one: the record and the thing it
 * records commit together or not at all. An audit entry written after the
 * commit can be lost by a crash in between — leaving an action with no record —
 * and one written before it can survive a rollback, leaving a record of an
 * action that never happened. Both look identical to a complete log, which is
 * what makes them worse than a missing one.
 *
 * Two things this is *not*:
 *
 * - It is not the event bus. `docs/events.md` says not to put anything a user
 *   would notice missing on the bus; this is for the things a *regulator* would
 *   notice missing, and it is a row in the same commit rather than a message
 *   that is delivered later.
 * - It is not the outbox either, although both write inside the caller's
 *   transaction. An outbox row is consumed and eventually pruned; an audit
 *   entry is kept, and the table it is kept in refuses to let anything modify
 *   it.
 *
 * **Call it last.** The append takes a global advisory lock that is held until
 * the caller's transaction ends, so everything the caller does after this call
 * is time no other audited write can start. See `PrismaAuditLogStore`.
 */
@Injectable()
export class AuditLog {
  constructor(@Inject(AUDIT_LOG_STORE) private readonly store: AuditLogStore) {}

  /**
   * Appends one entry, resolving with it as it was sealed.
   *
   * `resourceId` is a separate argument rather than a field of `details`
   * because it is indexed: "everything that happened to this account" is the
   * first question anybody asks of an audit log, and a value buried in a JSON
   * column answers it with a sequential scan.
   *
   * The returned entry carries the `seq` and `hash` the chain gave it, which is
   * what a caller logs or hands back to an operator as a receipt.
   */
  async record<K extends AuditActionName>(
    tx: TransactionContext,
    action: K,
    resourceId: string,
    details: AuditActionDetails[K],
    context: AuditContext = {},
  ): Promise<AuditEntry> {
    const draft = {
      action,
      resourceId,
      details,
      actor: context.actor ?? null,
      correlationId: context.correlationId ?? null,
      // Stamped here, inside the transaction, for the reason
      // `NewOutboxEvent.occurredAt` is: this is when the thing happened. There
      // is no database-assigned timestamp to fall back on — a column the hash
      // does not cover is a column an attacker may rewrite at will, so the
      // application clock is the only one, and it is inside the preimage.
      occurredAt: new Date(),
    } satisfies NewAuditEntry<K>;

    return this.store.append(tx, draft);
  }
}
