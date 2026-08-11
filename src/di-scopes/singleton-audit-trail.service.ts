import { Injectable } from "@nestjs/common";
import type { AuditEntry } from "./audit-trail.service";
import { InstantiationLedger } from "./instantiation-ledger.service";

/** How many entries one process keeps before the oldest are dropped. */
export const AUDIT_BUFFER_LIMIT = 1_000;

/**
 * The same audit trail, still a singleton.
 *
 * The only difference from {@link AuditTrailService} is that the correlation id
 * arrives as an argument instead of through an injected request-scoped
 * provider. That is the whole fix, and it is the first one to try: the caller
 * that wants something audited is almost always closer to the request than the
 * thing doing the auditing, so it already has the id or can be handed it.
 *
 * What that buys is not subtle. One instance for the process, so the buffer
 * accumulates as intended and a periodic flush has something to flush; nothing
 * above it in the dependency tree inherits a scope; and the instance can be
 * injected into a singleton, a guard, an interceptor or a scheduled job without
 * any of them needing a request to exist.
 *
 * The buffer is bounded because a singleton's memory is the process's memory:
 * an unbounded array on a request-scoped provider is freed with the request,
 * while the same array here grows until the pod is evicted. Trading the scope
 * for a longer lifetime means taking responsibility for that lifetime.
 */
@Injectable()
export class SingletonAuditTrail {
  readonly instanceId: string;

  private readonly buffer: AuditEntry[] = [];

  private dropped = 0;

  constructor(ledger: InstantiationLedger) {
    this.instanceId = ledger.record(SingletonAuditTrail.name);
  }

  record(action: string, correlationId: string): void {
    this.buffer.push({ action, correlationId });
    if (this.buffer.length > AUDIT_BUFFER_LIMIT) {
      this.buffer.shift();
      this.dropped += 1;
    }
  }

  /** Everything recorded since the process started, oldest first. */
  entries(): readonly AuditEntry[] {
    return [...this.buffer];
  }

  /** How many entries the bound above has discarded. */
  droppedCount(): number {
    return this.dropped;
  }
}
