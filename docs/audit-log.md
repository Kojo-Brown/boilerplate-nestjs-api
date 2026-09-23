# The tamper-evident audit log

Every audited action is a row in `audit_log`, written in the same transaction as
the action itself, in a table nothing may modify, hashed together with the entry
before it.

```ts
// The record and the thing it records commit together or not at all.
await this.transactions.run(async (tx) => {
  await this.users.delete(id, expected, tx);
  await this.outbox.stage(tx, "user.deleted", { userId: id, email });
  await this.audit.record(tx, "user.deleted", id, { email }, { actor });
});
```

| Piece                | Role                                                          |
| -------------------- | ------------------------------------------------------------- |
| `AUDIT_ACTIONS`      | The catalogue: every action name and the resource it concerns |
| `AuditLog`           | `record(tx, action, resourceId, details, ctx)` — the API      |
| `AUDIT_LOG_STORE`    | Persistence. `append` joins the caller's transaction          |
| `audit-hash.ts`      | Canonical encoding, the preimage, the chain                   |
| `AuditChainVerifier` | Walks the chain and reports the first entry that fails        |
| `AuditLogController` | `GET /v1/audit-log`, `GET /v1/audit-log/verify` — admin only  |

Everything below is the reasoning behind the parts that are not obvious.

---

## Two controls, not one

**The append-only triggers** refuse `UPDATE`, `DELETE` and `TRUNCATE` on the
table outright, with SQLSTATE `AU001`. They are what stop an ORM typo, a
`DELETE` with a forgotten `WHERE`, a "correction" somebody adds to a service, and
a compromised application role. Nothing in the application enforces this and
nothing in the application could: the point is that the refusal applies to
statements the application never issues.

**The hash chain** is what still works once somebody with `ALTER TABLE` is in
play. A table's owner can `DISABLE TRIGGER`, and a DBA is exactly the threat an
audit log is most often deployed against. Every entry carries a SHA-256 over its
own fields _and_ the previous entry's hash, so an edited row no longer hashes to
its stored `hash`, and a row re-hashed to fix that orphans every row after it.

Neither replaces the other. A trigger the owner can drop is not evidence;
evidence that only arrives when somebody remembers to verify is not a control.
`test/audit-log-store.db-spec.ts` asserts both against a real server — including
the tamper cases, which it performs by switching the triggers off first, because
that is the only way to reach them and saying so is the honest version of the
claim.

## What the chain catches, and what it does not

The verifier checks three things, and each catches a different attack:

| Check                            | Catches                                           |
| -------------------------------- | ------------------------------------------------- |
| Recompute every `hash`           | An entry whose contents were edited               |
| `prevHash` names its predecessor | An edited entry that was re-hashed to cover it up |
| `seq` is contiguous from 1       | A **deleted** entry                               |

The third is the one that is easy to leave out and impossible to do without.
Remove entry 7 and entries 1–6 and 8–n still hash perfectly, and 8 still links to
6's successor — nothing is wrong except a number that is not there. This is why
`seq` is assigned by the application under a lock rather than by a Postgres
sequence: a sequence advances for transactions that roll back, so it leaves gaps
of its own, and a gap that might be innocent is evidence of nothing.

**What it cannot catch** is a forger who rewrites the whole table from the
genesis entry forwards. The result is a perfectly valid chain of a history that
did not happen, and no mechanism held entirely by the party being audited can
detect it. The defence is an external witness: `GET /v1/audit-log/verify`
returns `headHash`, a single value that changes if any entry before it changes.
Write it somewhere this service cannot reach — another account's object store, a
log-shipping target, a transparency log, an email to the auditor — on a
schedule. Everything written before a witnessed head is then pinned by a value
the forger would also have had to rewrite, somewhere they do not have access.

## Why the append joins the caller's transaction

The same reason `TransactionalOutbox.stage` does, and the case is stronger here.

An entry written _after_ the commit is lost to a crash in between, leaving an
action with no record. An entry written _before_ it survives a rollback, leaving
a record of an action that never happened. Both look exactly like a complete log,
which is what makes them worse than an obviously missing one. Only one commit
carrying both removes the window.

This matters most for the operation an audit log exists for: a deletion is the
action that destroys the evidence of itself. `audit_log.actorId` is deliberately
**not** a foreign key for the same reason — `ON DELETE CASCADE` on that column
would make deleting an account erase the record of the deletion.

## Why appends are serialised, and what that costs

A hash chain is a total order by definition. Two appends cannot both read the
same tail and both extend it: one would overwrite the other's link, or the chain
would fork. So `PrismaAuditLogStore.append` takes
`pg_advisory_xact_lock(0x4155, 0x4c47)` before reading the tail.

An advisory lock rather than a row lock, because on an empty table there is no
tail row to lock — and that is precisely the moment two concurrent appends would
both decide they are the genesis entry. `docs/pessimistic-locking.md` named this
case before there was anything in it: an advisory lock is what you want when the
thing being protected has no row.

`_xact_` rather than a session lock, because it is released by the server at
commit or rollback. There is no lease to expire and no clock anybody has to be
right about, and the release happens at exactly the moment the tail becomes
visible to the next appender.

**The cost is real and is the trade this design makes.** Appends are serialised
globally, and the lock is held from the append until the caller's transaction
commits — so a transaction that audits early and then does something slow blocks
every other audited write for that long. Two consequences:

- `AuditLog.record` should be the **last** thing a unit of work does. Both call
  sites in this repository follow that, and say so.
- The ceiling is one audited transaction at a time. For the operations worth
  auditing — registrations, deletions, permission changes — that is nowhere near
  a constraint. If it ever became one, the fix is not a faster lock but a
  different structure: per-tenant or per-resource chains, each with its own lock
  and its own genesis, or a Merkle tree over batches rather than a linear chain.
  Both trade the single global order for concurrency, and both make "verify the
  whole log" a different operation.

## The preimage, and why it is not `JSON.stringify`

Two entries that differ must never hash alike, and one entry must always hash the
same way. `JSON.stringify` guarantees neither.

**Key order.** `JSON.stringify` follows insertion order, so `{ a: 1, b: 2 }` and
`{ b: 2, a: 1 }` — the same value by every meaning the application has —
serialise differently. An entry written by one code path and verified by another
would fail verification, which is the worst possible failure here: it cries
tampering at honest data, and the second time it does that nobody believes it
about the real thing. `canonicalJson` sorts keys recursively.

**Silent coercion.** `undefined` vanishes from an object, so `{ a: undefined }`
and `{}` hash alike. `NaN`, `Infinity` and `-Infinity` all become `null`, so
three distinct values collide. A `Date` is rewritten by its own `toJSON`, so the
bytes hashed are not the value passed. `canonicalJson` refuses all of it — the
append fails the caller's transaction rather than hashing a guess.

**Field boundaries.** Fields are length-prefixed rather than joined by a
separator. With `|` between them, an entry whose `resourceId` is `"a|b"` and
whose `action` is `"c"` produces the same bytes as one with id `"a"` and action
`"b|c"`: an attacker who controls one field controls the boundary, and two
entries collide with no collision in SHA-256 at all. Every value is written as
`name:<byte length>:<value>`, and `null` as `name:null`, so "no actor" and "an
actor whose id is the empty string" stay distinct.

The preimage opens with a version string. A future format change is then a
recognisable change of format rather than a table that suddenly fails to verify.

## The catalogue is not the event catalogue

`AUDIT_ACTIONS` and `DomainEventPayloads` overlap today — both know about
`user.registered` and `user.deleted` — and they are still separate on purpose.
`auth.refresh_token_reuse_detected` is the case that shows why: nothing
subscribes to a replayed refresh token, and the reason to record one is that
somebody will ask about it long after every message queue has been drained.
See `docs/refresh-token-rotation.md`.

A domain event is an announcement, and its payload is a contract with
subscribers: it is consumed, and the outbox row behind it is eventually pruned.
An audit entry is evidence: it is kept, and what it has to carry is whatever an
investigator will need years later, including for actions nobody subscribes to.
Merging them would make one set of fields answer to both, and the first time a
subscriber needed a field removed the record would lose it.

`AUDIT_ACTIONS` maps each action to its resource type, so `resourceType` cannot
disagree with `action` — there is no argument a caller could pass to make it.

## Reading it

`GET /v1/audit-log` serves entries in **chain order, oldest first**, paged with
`?afterSeq=`. Newest-first is what an operator scrolling a UI wants, and it is
the one order in which a page cannot be verified as it is read, so the store
offers only the ascending one and the endpoint documents why.

`seq` is a decimal **string** in every response. The column is `BIGINT` and the
value is a JS `bigint`; `JSON.stringify` throws on one rather than coercing it,
and `Number(seq)` rounds silently past 2^53. A string is the one representation
that survives JSON intact, and it is what a client hands back as `afterSeq`.

Both routes are admin-only. The log carries the email address of every deleted
account and the identity of everyone who acted, so it is strictly more sensitive
than the resources it describes. There is no `POST`: an endpoint that appended
would be a way to put a statement into the record with no action behind it.

## What this is not

- **Not a change feed.** An entry says what was done, not what the row looked
  like before and after. Field-level before/after is a different feature with a
  different retention story.
- **Not encrypted or redacted.** `details` is stored as written. Anything that
  must not be readable by an admin must not be put in it — which today means the
  two email addresses that are there deliberately, so a deleted account is still
  identifiable.
- **No retention policy, and none is possible without a decision.** The table
  cannot be deleted from, which is the point; trimming it means a migration that
  drops the triggers, archives a prefix of the chain, and records the hash it cut
  at so the remainder still anchors on something. Nothing here does that.
- **No signatures.** The chain proves internal consistency, not authorship. An
  entry signed with a key the application does not hold would prove _this build_
  wrote it; that needs a key custodian and is a larger change.
- **No automatic verification.** `GET /v1/audit-log/verify` is a full scan, run
  by an operator or a scheduled job. Nothing runs it on a timer, and nothing
  alerts on the result.

## Running it

Nothing to configure: the table is created by
`20260916000000_add_audit_log`, the module is global, and `AuditLog` is
injectable anywhere.

Adding an action is two steps:

1. an entry in `AUDIT_ACTIONS` naming its resource type, and its details
   interface in `AuditActionDetails`;
2. a `this.audit.record(tx, …)` call, last, inside the transaction that performs
   the action.

## Testing

| Suite                              | What it covers                                      |
| ---------------------------------- | --------------------------------------------------- |
| `audit-hash.spec.ts`               | Canonical encoding, the preimage, collision cases   |
| `audit-log-store.contract.spec.ts` | The store contract, against the in-memory double    |
| `test/audit-log-store.db-spec.ts`  | The same contract, plus the triggers and the lock   |
| `audit-chain.verifier.spec.ts`     | All four breach kinds, on a tampered chain          |
| `test/audit-log.e2e-spec.ts`       | Written by the real operations, read back over HTTP |

The in-memory double seals entries through the same `sealAuditEntry` the Prisma
adapter uses, so a chain an e2e spec reads is a chain production would have
written. What it cannot reproduce is the append-only refusal (a test can edit its
array; Postgres refuses) or serialisation under real concurrency (Node runs one
append at a time between awaits) — which is why the db-spec has no
skip-if-absent branch.
