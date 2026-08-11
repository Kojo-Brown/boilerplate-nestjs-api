import { Injectable } from "@nestjs/common";
import { InstantiationLedger } from "./instantiation-ledger.service";
import { RequestContextService } from "./request-context.service";

export interface AuditEntry {
  readonly action: string;
  readonly correlationId: string;
}

/**
 * The trap, written the way it actually shows up.
 *
 * Nothing about this file says `Scope.REQUEST`. It is declared exactly like
 * {@link FeatureFlagCache} — a plain `@Injectable()` — and its author clearly
 * meant it to be a singleton: `buffer` is an accumulate-then-flush buffer, the
 * shape you write when you expect one instance to see every entry the process
 * produces.
 *
 * It sees one request's entries, then is thrown away with them.
 *
 * The cause is the one line in the constructor that injects
 * {@link RequestContextService}. A provider is request-scoped if *anything in
 * its dependency tree* is, so this class inherited the scope of a dependency it
 * only wanted a correlation id from — and so did every provider that injects
 * *this* one, all the way up to the controller. Nest reports it through
 * `InstanceWrapper.isDependencyTreeStatic()`, which is what
 * {@link ScopeAudit} reads, and otherwise says nothing at boot: no warning, no
 * error, and every unit test still passes, because a test that constructs one
 * instance and makes one call cannot tell the difference.
 *
 * {@link SingletonAuditTrail} is the same class with the dependency removed and
 * the correlation id passed in as an argument. It is 15 lines longer at the
 * call sites and stays a singleton.
 *
 * Kept in the tree, wired, and asserted on — deleting it would take the
 * demonstration with it. It is not used by anything outside `src/di-scopes`.
 */
@Injectable()
export class AuditTrailService {
  readonly instanceId: string;

  private readonly buffer: AuditEntry[] = [];

  constructor(
    ledger: InstantiationLedger,
    private readonly context: RequestContextService,
  ) {
    this.instanceId = ledger.record(AuditTrailService.name);
  }

  record(action: string): void {
    this.buffer.push({ action, correlationId: this.context.correlationId });
  }

  /**
   * Everything recorded since construction — which, because of the scope this
   * class inherited, means "everything recorded during the current request".
   */
  entries(): readonly AuditEntry[] {
    return [...this.buffer];
  }
}
