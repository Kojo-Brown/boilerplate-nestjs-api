import type { TransactionContext } from "@/common/prisma/transaction.port";
import type { AuditEntry, NewAuditEntry } from "../audit-entry";

/** DI token for {@link AuditLogStore}. */
export const AUDIT_LOG_STORE = Symbol("AUDIT_LOG_STORE");

/** One page request. `afterSeq` is exclusive; omit it to start at the genesis entry. */
export interface AuditLogPageRequest {
  readonly afterSeq?: bigint;
  readonly limit: number;
}

/**
 * Persistence for the audit log.
 *
 * Three reads and one write, and the write is the interesting one: {@link
 * append} joins the caller's transaction and never opens one, exactly as
 * `OutboxStore.stage` does — for the same reason and with one more constraint
 * on top.
 *
 * The reason is atomicity. An audit entry committed separately from the thing
 * it records is not evidence: the operation can succeed with nothing written,
 * or the entry can survive an operation that rolled back. Both are worse than
 * no log at all, because both look exactly like a complete one.
 *
 * The extra constraint is that the chain is a *total order*. Two appends cannot
 * both read the same tail and both extend it — one of them would overwrite the
 * other's link, or they would fork. So an implementation has to serialise
 * appends against each other, and it must do so in a way that agrees with the
 * commit order rather than with the order the inserts were issued.
 */
export interface AuditLogStore {
  /**
   * Places `draft` at the end of the chain and writes it inside the caller's
   * transaction, resolving with the sealed entry.
   *
   * Every implementation seals through `sealAuditEntry`, so the hash is
   * computed in one place for all of them. What an implementation owns is the
   * serialisation: how it guarantees that no other append reads the same tail
   * before this transaction commits or rolls back.
   */
  append(tx: TransactionContext, draft: NewAuditEntry): Promise<AuditEntry>;

  /**
   * The last entry in the chain, or `null` while it is empty.
   *
   * This is what an external witness anchors on: publish the head hash
   * somewhere this service cannot reach, and every entry written before it is
   * fixed — see docs/audit-log.md.
   */
  head(): Promise<AuditEntry | null>;

  /**
   * Up to `limit` entries in chain order, starting after `afterSeq`.
   *
   * Ascending, and only ascending. Newest-first is what an operator scrolling a
   * UI wants, and it is the one order in which the chain cannot be checked
   * while it is read — so the verifier and the endpoint share this, and the
   * endpoint documents the order rather than the store offering two.
   */
  read(page: AuditLogPageRequest): Promise<readonly AuditEntry[]>;

  /** How many entries exist. For the verifier's report and for tests; it scans. */
  count(): Promise<number>;
}
