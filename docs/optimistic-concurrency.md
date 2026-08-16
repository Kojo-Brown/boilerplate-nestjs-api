# Optimistic concurrency

Two clients read the same user, both edit the name, both save. Without a
version, the second write wins and the first is gone — no error, no record, and
nothing either client can observe. That is the _lost update_ problem, and it is
what `ETag` / `If-Match` is for.

Every user row carries a `version` counter. A read returns it as a strong
`ETag`. A write must echo it in `If-Match`, and the write applies only if the
row is still at that version. If it has moved, the write is refused with
**412 Precondition Failed** and the client re-reads, re-applies its change, and
retries.

## The loop a client runs

```http
GET /v1/users/clx123
→ 200 OK
  ETag: "3"
  { "success": true, "data": { "id": "clx123", "name": "Ada", "version": 3 } }

PATCH /v1/users/clx123
If-Match: "3"
{ "name": "Ada Lovelace" }
→ 200 OK
  ETag: "4"
```

If someone else got there first:

```http
PATCH /v1/users/clx123
If-Match: "3"
→ 412 Precondition Failed
  { "statusCode": 412,
    "message": "If-Match precondition failed — sent \"3\", but the resource is now at \"4\"" }
```

Re-read, merge, retry with `If-Match: "4"`.

## Statuses

| Status        | When                                                              |
| ------------- | ----------------------------------------------------------------- |
| `200` / `201` | The precondition held. The response carries the **new** `ETag`.   |
| `400`         | `If-Match` was sent but is not a well-formed field value.         |
| `412`         | A well-formed `If-Match` that does not match the current version. |
| `428`         | A mutating request that sent no `If-Match` at all.                |

`428 Precondition Required` is RFC 6585 §3, defined for exactly this: the server
requires the request to be conditional "to prevent the 'lost update' problem".

### The order these are evaluated in

RFC 9110 §13.2.1 says preconditions are evaluated _after_ the server's normal
request checks and just before it would perform the action. So a request that is
wrong in more than one way hears about the other problem first:

```
401 / 403  →  400 (validation)  →  404  →  428  →  412  →  write
```

This is why `@IfMatch()` only extracts the header and `requireConditional()`
does the refusing, called from the service after authorization and existence.
A guard, an interceptor, or a throwing parameter decorator would all run too
early, and a client with a malformed body and no `If-Match` would fix the
header only to discover the body was wrong too — or be told to retry
conditionally on a resource it was never allowed to touch.

## Which endpoints require it

| Endpoint                          | `If-Match`            |
| --------------------------------- | --------------------- |
| `GET /v1/users/:id`               | — (returns an `ETag`) |
| `GET /v1/users/:id/preferences`   | — (returns an `ETag`) |
| `PATCH /v1/users/:id`             | required              |
| `POST /v1/users/:id/avatar`       | required              |
| `DELETE /v1/users/:id`            | required              |
| `PATCH /v1/users/:id/preferences` | required              |

`If-Match: *` is accepted everywhere and asserts only that the resource exists.
It is the right precondition when you genuinely mean "overwrite whatever is
there" — a script reconciling from an authoritative source, say — and the wrong
one for anything driven by a representation a user was looking at.

To relax a route, pass `@ApiConditionalWrite({ required: false })` for the
documentation and drop the `assertPrecondition` call from the service method
behind it. Optional means the client _may_ omit the header, not that a stale one
is forgiven: a mismatched `If-Match` is still a 412.

## Why the validator is the version and not a body digest

Every response goes through `ResponseEnvelopeInterceptor`, which stamps
`meta.timestamp`. A digest of the response bytes — which is what Express
generates by default — therefore changes on every request, so a client's
`If-Match` would fail against a resource nobody had touched. The version moves
when the row moves and at no other time, which is what a validator is for.
`EntityTagInterceptor` sets `ETag` before Express can, and Express only
generates one when none is already set.

## Weak tags

`W/"3"` never satisfies `If-Match`, even against version 3. RFC 9110 §8.8.3.2
forbids sending a weak tag in `If-Match`, and §13.1.1 requires the strong
comparison function, under which a weak tag matches nothing. The 412 body says
so explicitly, because a bare 412 against the exact version the client is
holding reads as a server bug.

A tag this server never issued — `"9f8b2c"`, or one from an older validator
scheme — is _syntactically_ valid and simply cannot match. That is a 412, not a 400.

## Preferences share the user's version

Preferences are a JSON column on the user row, so `PATCH /users/:id/preferences`
moves the _user's_ version, and one validator covers the row and every
projection of it. This is conservative: renaming your profile will fail an
`If-Match` on preferences that did not really conflict.

The alternative — a second counter for the JSON column — buys fewer false
conflicts at the cost of two validators for one row, which is how a client ends
up sending the wrong one. One row, one version.

It also closes a race that was already there. `setPreferences` is a
read-modify-write: it loads the current JSON, merges the patch, and writes the
result. Two concurrent patches both read version 5 and both write
`WHERE id = … AND version = 5`; the second matches no row and is refused
instead of silently discarding the first one's field.

## How the write is made atomic

The version predicate goes into the `WHERE` of the write itself, not into a
check before it:

```sql
UPDATE users SET name = $1, version = version + 1
WHERE id = $2 AND version IN (3)
```

Zero rows updated means the precondition lost. There is no window between
checking and writing, because there is no separate check.

Prisma reports "no row matched" as `P2025` whether the row is absent or merely
at another version — a 404 and a 412. `PrismaUsersRepository` tells them apart
by reading the row back: present and unsatisfying is a conflict, anything else
is the original failure, rethrown untouched. It goes through the state rather
than the error code deliberately, so the classification also holds against the
in-memory store the e2e suite runs the whole application on.

`assertPrecondition` _also_ checks the version before the write. That is a fast
path, not the guarantee — it keeps a 5 MB avatar upload from being spent on a
request that has already lost. The predicate on the write is what settles races.

## Caching

`GET /v1/users/:id` is cached for 30 seconds. That cache is now keyed by
`v1:users:<id>` — the same key `UsersService.invalidateUserCache` deletes.

It previously was not: the base `HttpCacheInterceptor` tracks by request URL, so
entries went in under `/v1/users/abc` while invalidation deleted `v1:users:abc`.
Every write left the read cached for the rest of the TTL. That was already a
correctness bug; with `ETag` it becomes a loop that does not terminate — the
stale read hands out a stale validator, the write is refused with 412, and the
re-read returns the same stale validator again. `UserResourceCacheInterceptor`
aligns the two keys.

## What this does not do

- **`If-None-Match` / 304.** Reads emit an `ETag` but do not honour a
  conditional read. Adding it is an interceptor on the read path, not a change
  to any of this.
- **Anything but users.** `src/common/concurrency` is resource-agnostic; the
  `version` column and the wiring exist only on `User` so far.
- **Cross-row transactions.** A version guards one row. Two rows that must move
  together need a transaction, and a write that must block rather than fail
  needs pessimistic locking — see [`pessimistic-locking.md`](./pessimistic-locking.md).
