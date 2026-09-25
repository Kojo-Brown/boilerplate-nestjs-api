# Field-level encryption at rest

`orders.itemsCiphertext` holds what a named customer bought, AES-256-GCM
encrypted under a data key that AWS KMS wraps. Nothing else in the schema is
encrypted at the column level, and the rest of this document is as much about
that boundary — what this buys, what it costs, and what it does not cover — as
about the mechanism.

The code is `src/crypto`. The one column that uses it is written and read by
`src/orders/prisma-order.store.ts`.

## What this is for

Disk encryption and RDS encryption-at-rest protect a stolen _volume_. They do
nothing about the threats that actually happen to a database: a backup copied to
somewhere it should not be, a read replica an analyst was given for one
afternoon, a `pg_dump` in a ticket attachment, a support engineer with
`SELECT`, an SQL injection that reaches a `SELECT *`. In every one of those the
volume is mounted and decrypted, and the column is in plaintext.

Field-level encryption moves the boundary to the row. The database holds
ciphertext, the key lives somewhere the database cannot reach, and a copy of the
data is worth nothing without a second, separately-authorised call to KMS.

## Envelope encryption, and why not the two simpler things

**Not `pgcrypto`.** `pgp_sym_encrypt(items, key)` puts the key in the SQL
statement, which puts it in `pg_stat_statements`, in the slow-query log, and in
the database's own memory — so the party that must not have the key has it on
every write. It also makes the key something the database _can_ hold, which is
the arrangement this exists to end.

**Not one key for everything.** Encrypting directly under a KMS key means a
round trip per value, a 4 KB payload limit, and every plaintext row travelling to
KMS and back. Envelope encryption inverts it: KMS mints a 32-byte **data key**
and hands back both the plaintext and a **wrapped** copy; this process encrypts
the value locally under the data key and stores the wrapped key beside the
ciphertext. KMS sees key material and never row data.

The wrapped key travels _with_ the value rather than in a key table. That costs
about 180 bytes per row and buys two things a shared key table does not: a row
restored from a backup still names the key it needs, and there is no single row
that every value in the system depends on.

## The stored format

```
byte  0        format version (1)
bytes 1-2      wrapped-key length, uint16 big-endian
bytes 3-14     96-bit GCM IV
bytes 15-30    128-bit GCM authentication tag
bytes 31-n     the wrapped data key (opaque; ~184 bytes from KMS)
bytes n+1-     the ciphertext
```

`src/crypto/field-envelope.ts`. Every length is checked against the buffer's
real length before anything is sliced, because `Buffer.subarray` clamps rather
than throwing — a truncated value would otherwise arrive at the cipher as a
short IV and fail there, several frames away, with a message about AES.

GCM rather than CBC or CTR because GCM authenticates. The threat model for a
database column is specifically an attacker who can _write_ it, and an
unauthenticated mode lets them flip bits in a stored value and have the
application accept the result.

## Two layers of authenticated data

Both layers exist, and they answer different questions.

**At the key layer**, the wrapped data key is bound to a KMS _encryption
context_ of `{purpose, table, column}`. KMS authenticates it: a `Decrypt` under
a different context is refused by the service. So a wrapped key lifted out of
one column cannot be presented as another's — and because CloudTrail records the
context, the key-use log says _which column_ was decrypted rather than merely
that something was.

The context is per column and not per row on purpose. One data key serves many
records, which is what makes the materials cache below possible; a per-record
context would mean a KMS call per insert and per read.

**At the value layer**, the GCM additional authenticated data is the format
version, the table, the column and **the record's id**, each length-prefixed.
AES-GCM covers it without storing it, so it costs nothing in the column and
cannot be stripped. It closes an attack the encryption alone does not: an
attacker who can write the database but not read the keys copies a victim's
ciphertext onto a row they control and has the application decrypt and render it
for them. `test/order-store.db-spec.ts` performs exactly that write against a
real Postgres and asserts the read refuses it.

The length prefixes are not decoration. Joined with a separator, a record id
crafted to contain the separator would let one field's value authenticate as
another's, with no weakness in AES-GCM at all — the same argument
`docs/audit-log.md` makes about its hash preimage, and the same fix.

## Why `KeyId` is pinned on `Decrypt`

`Decrypt` does not need a `KeyId`: the blob names the key that wrapped it, and
KMS will use that key if the caller's role may. That is the problem. An attacker
who can write the column and who holds _any_ key this role can decrypt under
replaces the wrapped data key with one they minted and then supplies a
ciphertext that authenticates under their data key. The per-record authenticated
data does not help, because they can compute it — it is derived from the table,
the column and the row id.

`AwsKmsKeyProvider` therefore names the configured key on every `Decrypt`, and
`key-provider.contract.spec.ts` runs that attack against an in-process KMS to
prove the refusal. It is the spec that fails if the `KeyId` is ever removed as
"redundant".

## The materials cache, and its two budgets

Without caching, envelope encryption costs a KMS round trip per value written
and per value read — a page of twenty orders becomes twenty-one remote calls.
`src/crypto/data-key-cache.ts` keeps one active data key per column and the
recently unwrapped keys needed for reads, so the steady state makes no remote
calls at all.

Caching key material is a deliberate weakening, and the two limits bound it in
two different currencies:

| Setting                           | Default | What it bounds                                                                                                                                                                                                                                                    |
| --------------------------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ENCRYPTION_DATA_KEY_TTL_SECONDS` | 300     | How long a memory compromise keeps paying, and how long after a KMS grant is revoked this process can still read rows. Capped at 3600.                                                                                                                            |
| `ENCRYPTION_DATA_KEY_MAX_USES`    | 10000   | How many values share one key. Capped at 2^32, the limit NIST SP 800-38D puts on GCM invocations under one key with a random IV — past it a repeated 96-bit IV stops being negligible, and in GCM that costs the authentication subkey rather than one plaintext. |
| `ENCRYPTION_DATA_KEY_CACHE_SIZE`  | 500     | How many key generations can be read back without a KMS call.                                                                                                                                                                                                     |

Retirement is **proactive**, which is the part worth knowing about. A key
replaced only once it has expired means the replacement — a real network call —
lands inside whichever request happens to arrive at that moment, and in this
codebase writes happen inside a database transaction. A remote call inside a
transaction holds a Postgres connection open for the length of somebody else's
network latency, which is exactly what `PlaceOrderHandler` is careful not to do
with a payment gateway. So past 80% of its budget the key is replaced in the
background and the caller is handed the current one. The cost is a few more data
keys than strictly necessary; `PrismaOrderStore.onApplicationBootstrap` covers
the one cold call that has no key to refresh yet.

The cached material is deliberately **not** zeroed on eviction. V8 copies and
relocates buffers as it collects them, so a `fill(0)` on the reference the cache
holds says nothing about the copies the heap may still contain, and a call site
mid-`await` would have its key zeroed underneath it. An assurance that cannot be
kept is worse than none; the control that does hold is that this process never
has the master key and the data keys it does have expire.

## Providers

| `ENCRYPTION_KEY_PROVIDER` | For                                                                                         | Requires                                                                             |
| ------------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `local`                   | A clean clone, the test suites, a laptop, and a deployment with nowhere better to put a key | `ENCRYPTION_LOCAL_MASTER_KEY` (32 bytes, base64)                                     |
| `kms`                     | Production                                                                                  | `ENCRYPTION_KMS_KEY_ID`, and a role that may `GenerateDataKey` and `Decrypt` with it |

`local` produces byte-for-byte the same envelope as `kms`, with the same
authenticated data and the same refusals — which is what makes it usable as a
test double: the properties the specs assert are properties of the production
path, and what is avoided is the network, not the cryptography.

`local` in production **warns at boot and is allowed**, which is a deliberate
departure from how `STORAGE_ADAPTER=memory` is treated two settings away. The
difference is what the alternative is. A deployment refused an in-memory store
goes and configures a real one, because the refusal is between working and
broken. A deployment refused a master key in its environment does not go and buy
a KMS — it ships the column in plaintext. The comparison that matters here is not
`local` against `kms`, it is `local` against nothing, and a master key from an
injected secret still defends against every threat listed at the top of this
document. It is also the same operational model this codebase already accepts for
`JWT_SECRET`, which sits in the same environment.

What it does _not_ give you, which is what the boot warning says: a key you
cannot exfiltrate, a key whose every use is logged, and a key an operator can
rotate without a redeploy. Anything that reads the process environment — a crash
dump, a logged `process.env`, a `kubectl describe`, an SSRF against the metadata
endpoint — has both halves. If a compliance regime says "customer-managed key" or
"HSM", `local` is not it, and the warning is there so nobody discovers that
during an audit.

There is no default master key, and generating one at boot is the one default
that must not exist: it works perfectly until the first restart, at which point
every row written before it is unreadable and nothing anywhere says so.
`envSchema` also refuses a master key that is not exactly 32 decoded bytes,
because base64 decoding ignores characters outside its alphabet — a truncated or
mistyped secret would otherwise be accepted as a _different_ key, which encrypts
fine and cannot read anything written under the intended one.

KMS credentials come from the SDK's default chain (IRSA on EKS, the instance
role on EC2) and deliberately not from the environment: the point of keeping the
master key in KMS is that holding the environment is not enough.

## What you give up: querying

The database cannot see inside the column. `items->>'sku'`, a GIN index and
every `jsonb` predicate are gone, and a column you can still query is a column
that is not encrypted.

`orders.items` was chosen partly because nothing was doing any of that — it is
written whole and read whole. For a field that _is_ looked up by value, the
answer is a **blind index**: a second column holding a truncated HMAC of the
normalised plaintext under a separate key, which supports equality lookup and
nothing else. It is not implemented here (see below), and the shape of the
trade-off is worth knowing before encrypting an email address on a whim:
deterministic values leak equality, and a blind index over a low-cardinality
field is a frequency table.

## Rotation

**The KMS key.** Point `ENCRYPTION_KMS_KEY_ID` at an `alias/…` and rotation is
an operator action rather than a deploy: re-point the alias and new data keys are
wrapped under the new key, while existing rows keep unwrapping under the key
their own blob names. Nothing has to be re-encrypted. KMS's automatic annual
rotation is transparent for the same reason — old material is retained for
decryption.

Note the consequence: a key that is _deleted_ rather than rotated takes every row
wrapped under it with it. `AwsKmsKeyProvider` reports that case as an operator
problem naming `ENCRYPTION_KMS_KEY_ID`, because it is one.

**The local master key.** Rotating it is a real migration, not an edit: rows
written under the old key stop being readable. Read every row with the old key,
re-encrypt with the new one, and only then remove the old. A boilerplate on a
development database is usually better off dropping the rows.

## Migrating a deployment that already has orders

`20260925000000_encrypt_order_items` **refuses to run on a non-empty `orders`
table**, by design and with a message that says so. There is no SQL backfill
because there cannot be one: encrypting a row means calling KMS for a data key,
which Postgres cannot do, and `pgcrypto` would mean handing the database the key.
A silent `DROP COLUMN` would have destroyed every order's contents.

For a deployment with rows, the cutover is three steps:

1. `ALTER TABLE "orders" ADD COLUMN "itemsCiphertext" BYTEA;` — nullable, and
   make the Prisma field optional. Write both columns, read `itemsCiphertext`
   when it is present and `items` otherwise.
2. Backfill through the application: read each row, `encryptJson` it against its
   own id, write the ciphertext. This is ordinary application code because it
   needs the key; it is resumable because a row with `itemsCiphertext` set is
   done.
3. Drop `items`, make `itemsCiphertext` `NOT NULL`, and remove the fallback
   branch.

Switching `ENCRYPTION_KEY_PROVIDER` between `local` and `kms` on a populated
database is the same shape of problem: neither provider can read the other's
wrapped keys, so it is a re-encryption pass, not a configuration change.

## Operating it

A failed decryption raises `FieldDecryptionError`, which names the column and
the row and never the value. `AllExceptionsFilter` renders it as a bare 500 with
no message — the diagnosis belongs in the log, where an operator reads it, and
not in a response body where an attacker probing with forged ciphertext reads it
too.

The causes, in rough order of likelihood:

- the row was written under a different master key or a different KMS key — a
  restored backup, a provider switch, a rotated-and-deleted key;
- the bytes were moved from another row or another column;
- the bytes were edited;
- KMS is refusing the call (this arrives as a `KeyProviderError` instead, which
  is the distinction that matters: one is a data problem and the other is an
  access problem).

`EnvelopeFormatError` is separate and means the bytes are not an envelope at all
— a migration or build mistake rather than anything to do with keys.

One line at boot says which provider is in use, because "which key is this
deployment encrypting under" is the first question asked when a row will not
decrypt, and the answer is otherwise nowhere in the logs.

## Not done

- **Only one column.** `saga_instances.state` carries the same order lines while
  a checkout is in flight, and keeps them afterwards, so a deployment that
  encrypts `orders.itemsCiphertext` and nothing else still has that data in
  plaintext in another table. Converting it is a separate change and a more
  delicate one: every write to that column goes through a lease-conditional raw
  `UPDATE … RETURNING`, and the recovery poller reads it on every tick.
- **No blind index**, so no encrypted field can be looked up by value. See above
  for what one would cost.
- **No searchable or order-preserving encryption**, and none is planned: both
  leak more than most people expect.
- **The audit log is not encrypted.** `audit_log.details` is a hash-chained
  column and encrypting it would entangle two mechanisms that are currently
  independent; `docs/audit-log.md` already notes that there is no redaction of
  `details`.
- **No per-tenant keys.** One data key per column, not per customer, so this is
  not the control a "customer-managed key" requirement means.
- **No KMS grant tokens and no key policy shipped.** The IAM policy the role
  needs (`kms:GenerateDataKey` and `kms:Decrypt`, ideally with a
  `kms:EncryptionContext:table` condition) belongs in
  `boilerplate-devops` beside the other least-privilege policies.
- **Nothing measures it.** There is no counter for KMS calls, cache hits or
  decryption failures, and a decryption failure is arguably the most
  alert-worthy event in this document.
