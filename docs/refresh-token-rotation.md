# Refresh-token rotation and reuse detection

`POST /v1/auth/refresh` spends the token it is given and issues a new pair. That
much was already true. What this document is about is the half that rotation on
its own does not buy you.

## Why rotation alone protects nothing

Suppose a refresh token leaks — from a log, a shared device, an XSS payload, a
backup. With plain rotation, both the thief and the owner hold the same usable
credential. Whichever presents it first rotates it and walks away with a fresh
chain. The other is told "unknown token", signs in again, and nothing anywhere
records that anything happened.

Notice that the outcome is the same whichever of them was first. If the thief
wins the race, the owner is bounced to the sign-in page for no reason they can
see and the thief keeps a live session indefinitely. Rotation shortened the life
of one token; it did not shorten the life of the compromise.

The missing piece is that **a rotated token coming back is evidence**. The
legitimate client has no reason to present a token it has already exchanged. If
one arrives, two parties hold it — and at that moment there is no way to tell
which of them is at the door.

## The mechanism

Three changes, and each one is load-bearing:

1. **Spent tokens are kept.** `refresh_tokens.consumedAt` is set on rotation
   instead of the row being deleted. A deleted token replays as "unknown", which
   is exactly what a typo looks like, so the one event worth acting on was being
   discarded.
2. **Tokens belong to a family.** Every sign-in starts a `refresh_token_families`
   row; every rotation issues the successor into the same family. The family is
   the chain, and the chain is what a replay implicates — not the single token
   that happened to be replayed.
3. **A replay revokes the family.** `refresh_token_families.revokedAt` is set
   with `revokedReason = REUSE_DETECTED`, and from then on every token in the
   chain — including the live successor the honest client is holding — is
   refused.

```
sign in ──► t1 ──rotate──► t2 ──rotate──► t3          (family F, live)
             │
             └── t1 presented again ──► F revoked, t2 and t3 dead too
```

This is the behaviour RFC 9700 (OAuth 2.0 Security Best Current Practice)
§4.14.2 describes for public clients that cannot keep a secret, which is every
browser and mobile client this API serves.

## What it costs, stated plainly

**A client that retries a refresh without persisting the new token first will be
signed out.** That is not a bug to be tuned away — it is the same event as a
theft, seen from the server, and the server cannot see the difference.

The fix belongs in the client, and it is small: treat the refresh response as
committed only once the new refresh token is durably stored, and never re-send a
token you have already exchanged, even if the response never arrived. If the
response was lost, the correct recovery is to sign in again, not to retry.

A **grace window** — accept a replay within N seconds and hand back the same
successor — is the usual counter-proposal, and it is deliberately not
implemented here. It is exactly N seconds during which a stolen token works, the
window has to be longer than the worst retry a flaky network produces, and the
resulting number is one nobody can justify from either direction. If you decide
you want one anyway, it belongs in `PrismaRefreshTokenStore.consume`, next to the
`consumedAt` check, and it should be a documented configuration value rather
than a constant.

The blast radius is the **family**, not the account. One compromised session
does not sign the user out of their other devices: each sign-in has its own
family, and the evidence only implicates the chain the replayed token was in.

## What is recorded

Two things, and neither is a domain event:

- A `warn` line naming the family, the account and how many unspent tokens the
  revocation took away.
- An audit entry, `auth.refresh_token_reuse_detected`, against the family. This
  is evidence rather than an announcement, so it goes in the tamper-evident log
  (`docs/audit-log.md`) rather than the outbox, which is delivered and then
  swept.

The entry has **no actor**. Two parties held that token; nothing in the request
says which one presented it, and naming the account holder would be recording a
guess as evidence. The account is in the entry's details instead.

The entry is written **once per family**. A store that reported a detection on
every presentation would let an attacker write one audit entry — and fire one
alert — per request they chose to send. The store returns `reused` from the
presentation that performs the revocation and `revoked` from every one after it.

If the audit append itself fails, the request is still refused. The security
response already committed inside the store's transaction; losing the record
must not turn a 401 into a 500, which reads as "try again" to a client. The
failure is logged at `error` with the same facts the entry would have carried.

## Signing out

`POST /v1/auth/logout` revokes the family too, with `revokedReason = LOGOUT`.
Two consequences worth knowing:

- Signing out ends the **session**, not just the token presented. Every
  predecessor in the chain stops working at the same moment. Revoking only the
  presented token would leave them replayable for as long as the family lived.
- A token replayed after a sign-out is **not** reported as an attack. The family
  is already over, there is nothing left to revoke, and treating every stale
  token a signed-out client retries as an intrusion would bury the real ones.

The first reason wins: a sign-out arriving after a replay does not overwrite
`REUSE_DETECTED` with `LOGOUT`. Relabelling an attack as routine is the one
direction that loses information.

## Retention, and why you have to schedule something

Keeping spent tokens is what makes the detection possible, and it means this
table only grows. `RefreshTokenStore.prune(before)` deletes every family whose
tokens have all expired before `before`; the tokens go with it through the
foreign key's cascade.

Two things to get right when you schedule it:

- **Prune by family, not by token.** Deleting the spent generations of a live
  chain would leave exactly the blindness this design removes: a replay of a
  pruned token reports `unknown`. `prune` is scoped to families for that reason.
- **Leave a margin past expiry.** A family is prunable when nothing in it can
  still be presented, which is `JWT_REFRESH_EXPIRY` after its last rotation.
  Pruning at exactly that boundary is fine for correctness and gives you no
  forensic window at all; a few days beyond it costs one row per sign-in.

**Nothing in this repository calls `prune` on a schedule.** There is no cron or
scheduler module here, and adding one for a single sweep would be the tail
wagging the dog — wire it to whatever your deployment already runs periodically,
or add `@nestjs/schedule` and one job. Until you do, the table grows without
bound, and on a busy service that is a real operational problem rather than a
theoretical one.

## What this does not do

- **Access tokens are not revoked.** The JWT stays valid until it expires
  (`JWT_ACCESS_EXPIRY`, 15 minutes by default), because nothing here checks a
  revocation list on every request. Revoking a family stops the chain from being
  _extended_; it does not cut the access token already in flight. Shortening the
  access-token lifetime is the dial that bounds this.
- **The user is not told.** No email, no push, no "we signed you out of a
  session" notice. `src/notifications` could carry one, and a replay is arguably
  the single most notification-worthy event this service produces, but that is a
  product decision and not this change.
- **Nothing is rate-limited on the strength of a detection.** A replay does not
  make the API any less willing to talk to whoever sent it. The throttler's
  limits on `/v1/auth/refresh` are the same before and after.
- **There is no "sign me out everywhere".** Revoking every family for an account
  is one `updateMany` away and has no endpoint, because who may trigger it — the
  user, an admin, a support agent — is a question this boilerplate does not
  answer for you.
- **Families are not described to the client.** There is no session list, no
  device name, no "last used from". The rows carry only what the detection
  needs.

## Testing this

The properties live in `src/auth/refresh-token-store.contract.ts` and run twice:
against Postgres in `test/refresh-token-store.db-spec.ts`, and against the
in-memory double in `src/auth/refresh-token-store.contract.spec.ts`. Asserted
only against Postgres, nothing would stop the double the e2e suite runs the
whole application on from letting two callers both claim one token; asserted
only against the double, they would be properties of a promise chain.

```bash
pnpm test                       # contract vs. the double, AuthService, the e2e replay
docker compose up -d postgres
export DATABASE_URL=postgresql://postgres:postgres@localhost:5432/app_db
pnpm db:migrate:prod
pnpm test:db                    # contract vs. Postgres, plus the two-connection cases
```

The two-connection cases are the ones a single client cannot produce: two
different spent tokens of one family replayed simultaneously, which is what the
family lock exists for, and a rotation raced across connections, which is what
the token lock exists for.
