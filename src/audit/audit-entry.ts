/**
 * The catalogue of things worth recording, and what each one is recorded
 * *about*.
 *
 * One object is the single source of truth for every action name and the
 * resource type it concerns, for the same reason `DomainEventPayloads` is one
 * interface: an action whose name and resource type are declared in two places
 * is an action they will eventually disagree about, and `resourceType` is an
 * index this table is read through.
 *
 * Adding an action is one entry here plus its details interface below. Nothing
 * else in `src/audit` needs to change.
 *
 * This is deliberately *not* the domain-event catalogue, even though the two
 * overlap today. A domain event is an announcement to other parts of the system
 * and its payload is a contract with subscribers; an audit entry is evidence,
 * and what it has to carry is whatever an investigator will need years later —
 * including for actions nobody subscribes to, like a failed login. Merging them
 * would make one set of fields answer to both, and the first time a subscriber
 * needed a field removed the record would lose it.
 */
export const AUDIT_ACTIONS = {
  "user.registered": "user",
  "user.deleted": "user",
} as const satisfies Record<string, string>;

export type AuditActionName = keyof typeof AUDIT_ACTIONS;

/**
 * What travels with each action.
 *
 * Every payload here is JSON-shaped by construction — strings, numbers,
 * booleans, nulls, and objects and arrays of those. Nothing else may go in: the
 * value is hashed through {@link canonicalJson}, which rejects anything it
 * cannot serialise unambiguously, and a `Date` or a `BigInt` that reached this
 * far would fail the append rather than the review.
 */
export interface AuditActionDetails {
  "user.registered": UserRegisteredAudit;
  "user.deleted": UserDeletedAudit;
}

/** An account was created, by whatever route. */
export interface UserRegisteredAudit {
  readonly email: string;
  /** `"google"` for OAuth sign-ups, `null` for email + password. */
  readonly provider: string | null;
}

/**
 * An account was deleted.
 *
 * The address is on the entry because the row is gone: "who deleted this user
 * and when" is answerable from the chain long after nothing can look the user
 * up, which is most of the reason this table exists.
 */
export interface UserDeletedAudit {
  readonly email: string;
}

/**
 * Who performed the action, or `null` when the system did.
 *
 * Denormalised rather than joined. The role recorded here is the one the actor
 * held *at the time*: read back through a join it would be whatever they hold
 * now, which is exactly the fact an investigation cannot rely on.
 *
 * `role` is a plain `string` rather than the `Role` enum, matching the column.
 * It is what the caller's credential claimed — `AuthenticatedUser.role`, read
 * off a JWT — and narrowing it to today's enum would mean either a cast or a
 * 500 on a token minted before a role was retired. The audit log's job is to
 * record what was presented, not to re-litigate whether it is still a role.
 */
export interface AuditActor {
  readonly id: string;
  readonly role: string;
}

/** What the caller knew about the wider operation. Mirrors `StageContext`. */
export interface AuditContext {
  readonly actor?: AuditActor | null;
  readonly correlationId?: string | null;
}

/**
 * An entry on its way into the log, before the chain has placed it.
 *
 * Everything the *caller* decides. `seq`, `prevHash` and `hash` are not here:
 * they are decided by the store, under the lock that serialises the chain, and
 * a caller that could choose them could choose to overwrite history.
 *
 * Parameterised over one action rather than being a union of all of them, for
 * the reason `NewOutboxEvent` is: a call site knows statically which action it
 * is recording, so `K` is pinned there and `details` is checked against that one
 * action.
 */
export interface NewAuditEntry<K extends AuditActionName = AuditActionName> {
  readonly action: K;
  readonly resourceId: string;
  readonly details: AuditActionDetails[K];
  readonly actor: AuditActor | null;
  readonly correlationId: string | null;
  /** When the audited thing happened, stamped inside its transaction. */
  readonly occurredAt: Date;
}

/**
 * An entry as it sits in the table: placed in the chain and sealed.
 *
 * `action` is a plain `string` rather than {@link AuditActionName}, and
 * `details` is `unknown` rather than the matching payload. That is not
 * laziness — it is what the table can honestly promise. Entries outlive the
 * build that wrote them: a deploy that retires an action still has to be able
 * to read back, and *verify*, the entries written under it. A union typed
 * against today's catalogue would make that a cast at every read, and the one
 * operation this type exists for — recomputing the hash — needs none of it.
 */
export interface AuditEntry {
  readonly seq: bigint;
  readonly occurredAt: Date;
  readonly action: string;
  readonly resourceType: string;
  readonly resourceId: string;
  readonly details: unknown;
  readonly actorId: string | null;
  readonly actorRole: string | null;
  readonly correlationId: string | null;
  /** The previous entry's {@link hash}, or `GENESIS_HASH` for `seq` 1. */
  readonly prevHash: string;
  /** SHA-256 over the fields above *and* `prevHash`, lower-case hex. */
  readonly hash: string;
}
