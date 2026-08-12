# Idempotency

A client that never sees a response cannot know whether the operation happened.
It has two bad choices — retry and risk doing it twice, or give up and risk not
doing it at all — and neither is acceptable when the operation charges a card.
`Idempotency-Key` gives it a third: retry freely, and let the server recognise
the retry.

This is `src/common/idempotency`. The shape follows
[draft-ietf-httpapi-idempotency-key-header][draft], which is also where the
status codes come from.

[draft]: https://datatracker.ietf.org/doc/draft-ietf-httpapi-idempotency-key-header/

## Using it

Send a unique key on any `POST`, `PUT`, `PATCH` or `DELETE`:

```http
PATCH /v1/users/clx123 HTTP/1.1
Authorization: Bearer <token>
Idempotency-Key: 6f1c0b2e-0f5f-4d3a-9b2a-6a2c1d9e7f10
Content-Type: application/json

{"name":"Ada"}
```

The first request runs normally. Any later request with the same key gets that
first response back — same status, same body, same `Content-Type` — with one
extra header:

```http
HTTP/1.1 200 OK
Idempotency-Replayed: true
```

A key must be 1–255 printable ASCII characters. Generate one per logical
operation, not per attempt: every attempt at the same operation must carry the
_same_ key, or there is nothing to deduplicate.

Nothing changes for a client that does not send the header. The feature is
opt-in per request, so no existing route behaves differently until a caller asks
it to.

## What each answer means

| Status                                        | When                                                            | What the client should do             |
| --------------------------------------------- | --------------------------------------------------------------- | ------------------------------------- |
| normal response, no extra header              | first attempt                                                   | nothing                               |
| normal response, `Idempotency-Replayed: true` | a retry of a finished request                                   | nothing — this is the original answer |
| `400 Bad Request`                             | the key is blank, over 255 characters, non-ASCII, or sent twice | fix the key                           |
| `409 Conflict`                                | the first attempt is still running                              | wait and retry the same key           |
| `422 Unprocessable Content`                   | the key was already used for a _different_ request              | use a new key                         |
| `503 Service Unavailable`                     | the dedupe store is unreachable                                 | retry the same key                    |

The 503 is deliberate. If the store cannot say whether a key has been seen, the
server cannot tell a first attempt from a retry, and running the handler anyway
is exactly how a client gets charged twice. It fails closed: mutating requests
become unavailable rather than unsafe.

## What counts as "the same request"

The key alone is not enough — a client that reuses one key for two different
operations would otherwise be handed the wrong response. Each key is stored with
a fingerprint of the request that claimed it: the method, the full path and
query string, the `Content-Type`, the `Content-Length`, and the parsed body with
its object keys sorted. A retry whose fingerprint differs gets 422.

Sorting the keys matters: a client that rebuilds its retry from a map may emit
`{"a":1,"b":2}` the first time and `{"b":2,"a":1}` the second. That is the same
request and is treated as one.

**Known limitation.** The raw bytes of a `multipart/form-data` upload are
consumed by the file parser before the fingerprint is taken, so two different
files posted under one key are distinguished only by `Content-Length`. Two
uploads of identical length under a single key will replay the first. If that
matters for your routes, hash the file yourself and send the digest in a field
the fingerprint can see.

## Which responses are recorded

Anything under 500, including 4xx. The same key naming the same request has the
same answer, and a client that "fixes" its payload while reusing the key is the
bug this refuses rather than accommodates.

At 500 and above the server does not know what happened. Recording that would
make it permanent for the lifetime of the key and take the retry away from the
client, so the reservation is released and the next attempt runs for real. The
same applies when the connection drops before the response is written, and when
a handler streams its body instead of calling `res.send()` — there is nothing to
reproduce, so the key is freed rather than pinned to a response the module never
saw.

## Scoping

Keys are namespaced per caller: `user:<id>` when the request is authenticated,
`ip:<address>` when it is not. A global namespace would let anyone replay
someone else's response — including its body — by guessing a key.

The `ip:` fallback is weaker: two clients behind one NAT share a namespace. The
fingerprint check is what keeps that safe, since two genuinely different
requests under one key get 422 rather than each other's responses.

## Configuration

| Variable                  | Default  | Meaning                                 |
| ------------------------- | -------- | --------------------------------------- |
| `IDEMPOTENCY_STORE`       | `memory` | `redis` or `memory`                     |
| `IDEMPOTENCY_TTL_SECONDS` | `86400`  | how long a key stays claimed            |
| `REDIS_URL`               | —        | required when `IDEMPOTENCY_STORE=redis` |

`memory` is the default so a clean clone boots with nothing configured, and it
is **refused in production** by `env.schema.ts`. Two replicas do not share a
`Map`: the retry that a load balancer sends to the other one finds no record and
executes the operation a second time — silently, and precisely when the feature
is supposed to be working.

The TTL restarts when the response is recorded, not when the key was reserved,
so a slow handler does not shorten the window its own response is replayable
for.

## How it works

`IdempotencyInterceptor` is bound globally in `main.ts`, between
`LoggingInterceptor` and `ResponseEnvelopeInterceptor`. The order is
load-bearing:

- **Logging outermost**, so a replayed request still gets a correlation id and
  an access-log line.
- **Idempotency above the envelope**, because a replay is written to the
  response verbatim rather than handed back to the serialiser, and because what
  gets recorded is read off `res` — after every interceptor, pipe and filter has
  had its turn. Reading the handler's return value instead would record
  something that merely resembles what the client received.

The capture works by wrapping `res.send`, which is the one place every response
in this application passes through: handler results via Nest's Express adapter,
validation failures via `ValidationPipe`, and errors via `AllExceptionsFilter`.

Per request, with the header present and the method mutating:

1. **Reserve.** `store.reserve` atomically claims `<scope>:<key>` with an
   in-flight record. If it comes back with an existing record, the request is a
   retry: replay, 409, or 422 as the table above says.
2. **Run.** The handler executes exactly as it would have without the header.
3. **Record.** On `finish`, the status, `Content-Type` and body are written back
   under the same key. On a 5xx, an abort, or a body that never went through
   `send`, the reservation is released instead.

### Why the store is a port

`IdempotencyStore` (`ports/idempotency-store.port.ts`) has two implementations:
`RedisIdempotencyStore` and `InMemoryIdempotencyStore`. Only `reserve` has to be
atomic, and that is the whole reason it is a port rather than a `Map` behind the
interceptor: two replicas receiving the same retry at the same instant must not
both conclude they are first. Redis settles that with `SET NX`; the in-memory
store settles it with the event loop, which is honest for exactly one process.

Both are held to one behavioural contract in
`idempotency-store.contract.ts`, run against a real `redis-server` and against
the `Map` — because a divergence between them is not a failing test, it is a
duplicate charge the first time someone switches backends.

### The lease

Every reservation carries a randomly generated lease, and `complete` and
`release` require it. It is a fencing token.

Suppose request A outlives its own reservation. The key expires, retry B claims
it, and then A finishes. Without the lease, A's `release()` would delete _B's_
reservation and let a third attempt run alongside B; A's `complete()` would
overwrite B's answer with a stale one. With it, A's writes are refused and B is
left alone. On Redis the check and the write are one Lua script, so a retry
cannot slip between them.

The lease does not prevent the double execution that a too-short TTL causes —
nothing at this layer can. It prevents that situation from getting worse.

## Testing

- `idempotency-key.spec.ts` — key validation, scoping, fingerprinting.
- `idempotency.interceptor.spec.ts` — every decision the interceptor makes,
  against a hand-written response double whose event order matches Express's.
- `idempotency-store.contract.spec.ts` — one contract, both stores, real Redis.
- `stores/*.spec.ts` — what the contract cannot reach: unreadable records, key
  namespacing, the in-memory store's injected clock.
- `test/idempotency.e2e-spec.ts` — the wiring, over real HTTP.

The Redis legs need a running Redis and are reported as pending without one. CI
always runs them: the test job has a `redis:8-alpine` service and sets
`REDIS_URL`. To run them locally:

```bash
docker run -d -p 6379:6379 redis:8-alpine
REDIS_URL=redis://localhost:6379 pnpm test
```
