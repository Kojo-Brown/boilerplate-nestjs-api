# OWASP API Security Top 10 (2023)

One row per risk: what this application does about it, and the test that says so.

Every mitigation is covered twice in
[`test/owasp-api-top10.e2e-spec.ts`](../test/owasp-api-top10.e2e-spec.ts) — once by
an attack that must fail, and once by a **negative control** in which that one
mitigation is removed and the same attack must land. The second half exists
because a passing security assertion has two possible causes. Either the
mitigation works, or the request was refused a step earlier for a reason nobody
wrote down and nobody will notice changing. A suite made only of the first kind
accumulates the second kind quietly, and stays green on the day somebody deletes
a guard.

So "failing-then-passing" is not a claim about how these tests were written; it is
a property the suite keeps. Each control removes exactly one thing — a guard's
`canActivate` stubbed for the length of one test, a projection compared against
the row it was built from, an application built without one piece of middleware —
and sends the identical request, so the difference in the answer is attributable
to the mitigation and to nothing else.

Two rows below are **not** closed. They are in the table because a checklist that
only lists wins is a marketing document.

## The table

| Risk                                                     | Mitigation                                                                                                                                                                                                                               | Where                                                                                                                                                                                          | Test                                         |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| **API1** Broken Object Level Authorization               | `UserAccessPolicy` answers "is this yours?" for every user-owned action; an order that is not yours is a 404, not a 403                                                                                                                  | [`users.access-policy.ts`](../src/users/users.access-policy.ts), [`get-order.query.ts`](../src/orders/read/get-order.query.ts)                                                                 | 3 + control ⚠️ **one open item — see below** |
| **API2** Broken Authentication                           | `JwtAuthGuard` is a global `APP_GUARD`: authentication is the default and `@Public()` is the opt-out. Refresh tokens are single-use, and a replay revokes the whole family                                                               | [`app.module.ts`](../src/app.module.ts), [`jwt.strategy.ts`](../src/auth/strategies/jwt.strategy.ts), [`refresh-token-rotation.md`](./refresh-token-rotation.md)                               | 4 + control                                  |
| **API3** Broken Object Property Level Authorization      | Outbound: `toUserResponse` publishes a written list of fields. Inbound: `ValidationPipe({ whitelist, forbidNonWhitelisted })` refuses a property no DTO declares                                                                         | [`user-response.dto.ts`](../src/users/dto/user-response.dto.ts), [`main.ts`](../src/main.ts)                                                                                                   | 3 + control                                  |
| **API4** Unrestricted Resource Consumption               | Page size capped at 100 by the DTO; per-route rate limits over `ProxyAwareThrottlerGuard`; bounded worker pool, bulkheads and per-call deadlines on every outbound dependency                                                            | [`cursor-pagination.dto.ts`](../src/common/pagination/cursor-pagination.dto.ts), [`throttler.guard.ts`](../src/common/guards/throttler.guard.ts), [`http-resilience.md`](./http-resilience.md) | 2 + control                                  |
| **API5** Broken Function Level Authorization             | `RolesGuard` is global and every admin-only handler carries `@Roles`. The public surface is pinned in the suite, so opting a route out of authentication is a line a reviewer sees                                                       | [`roles.guard.ts`](../src/auth/guards/roles.guard.ts), [`app.module.ts`](../src/app.module.ts)                                                                                                 | 6 + control                                  |
| **API6** Unrestricted Access to Sensitive Business Flows | Checkout reserves stock, charges a card and books a carrier; `Idempotency-Key` makes a retry replay the first response instead of repeating all three                                                                                    | [`idempotency.interceptor.ts`](../src/common/idempotency/idempotency.interceptor.ts), [`idempotency.md`](./idempotency.md)                                                                     | 1 + control                                  |
| **API7** Server Side Request Forgery                     | No endpoint accepts a URL and fetches it: every outbound base URL comes from validated configuration. Request input that reaches an outbound _path_ is `encodeURIComponent`d, so an id cannot become a different endpoint                | [`stripe-payment.provider.ts`](../src/payments/providers/stripe-payment.provider.ts)                                                                                                           | 1 + control                                  |
| **API8** Security Misconfiguration                       | Helmet with a strict CSP and HSTS, a CORS allowlist from the environment, and an exception filter that answers "Internal server error" rather than the exception                                                                         | [`apply-security.ts`](../src/common/security/apply-security.ts), [`all-exceptions.filter.ts`](../src/common/filters/all-exceptions.filter.ts), [`security-headers.md`](./security-headers.md)  | 2 + control                                  |
| **API9** Improper Inventory Management                   | Every reachable route is published in the OpenAPI document and served under `/v1`, or listed as a deliberate exemption. Checked against the router the process will actually match, not against the decorators                           | [`route-inventory.ts`](../src/common/swagger/route-inventory.ts)                                                                                                                               | 1 + 19 unit                                  |
| **API10** Unsafe Consumption of APIs                     | A message read off the broker is validated against the schema the registry holds for its event name before any subscriber sees it. A foreign producer on the same topic cannot push an unknown event or a malformed payload onto the bus | [`domain-event-codec.ts`](../src/messaging/domain-event-codec.ts), [`schema-registry.md`](./schema-registry.md)                                                                                | 1 + control                                  |

## What this exercise found

The checklist was not a formality. Writing it turned up two defects in code that
was already covered by 195 e2e tests and 2900 unit tests.

### `GET /v1/users/:id` was publishing password hashes

The users resource returned the Prisma row straight through from all four of its
user-returning endpoints. `UserResponseDto` had documented a narrower shape since
the beginning and nothing enforced it, so any authenticated caller could read any
other account's argon2 hash and its `providerAccountId`:

```
GET /v1/users/<anyone> → 200
{ "success": true, "data": { …, "password": "$argon2id$v=19$m=65536,t=3,p=4$…" } }
```

Every other resource in the repository already did this correctly —
`toOrderResponse` exists and its comment states the rule: _what leaves the process
is decided by a list somebody wrote_. Users was the one place that had not
followed it. `toUserResponse` is that list, as an allowlist rather than a
`delete row.password`, because a denylist is only correct until the next column is
added.

`preferences` came off the profile projection in the same change. It has its own
endpoint, `GET /v1/users/:id/preferences`, which answers 403 for somebody else's —
a check that meant nothing while the same object rode along on a profile response
that anyone could fetch.

### Authentication was opt-in, and `@Public()` was decorative

`JwtAuthGuard` was applied controller by controller with `@UseGuards`. The
`@Public()` decorator existed, the guard honoured it, and nothing used it —
because a guard that is not registered globally has nothing to be excused from.

That arrangement fails silently in one direction. A controller added without the
decorator is reachable by anyone, and nothing in a review diff or a test run says
so. Reversing the default makes the same mistake fail in the safe direction, and
makes every public route a line somebody wrote on purpose:

```
POST /v1/auth/register        no token can be presented for the endpoint that issues tokens
POST /v1/auth/login
POST /v1/auth/refresh
GET  /v1/auth/google          Passport's redirect pair: the GoogleAuthGuard *is* the
GET  /v1/auth/google/callback   authentication, and cannot run behind a bearer check
GET  /v1/health               probed by an orchestrator, which holds no credential
GET  /metrics                 scraped by Prometheus, likewise
GET  /v1/di-scopes            the DI teaching endpoint; delete src/di-scopes and this goes too
```

Both probes on that list belong on the internal listener rather than the ingress:
public means _unauthenticated_, not _safe to expose to the internet_.

Removing the one line that registers the global guard fails 11 of the suite's 33
tests, across six of the ten risks.

## The rows that are not closed

### API1 — presigned URLs are not scoped to the caller (open)

`POST /v1/storage/presigned-upload` and `/presigned-download` take an object key
from the request and sign a URL for it. Any authenticated caller may name any key.
With `STORAGE_ADAPTER=s3` that is read access to every object in the bucket and
write access over every object in it, including another user's avatar.

Path traversal is not the issue — `assertValidObjectKey` handles that, and is
tested. The missing thing is ownership: nothing ties a key to the caller.

It is left open rather than patched here because the fix is a decision about what
the bucket is _for_. Scoping keys to a `users/<callerId>/` prefix would close it
and would also stop the generic object store being generic, which is what the
endpoint is currently documented as. That belongs in a change of its own, with
that trade-off in its description, rather than smuggled into a checklist.

### API1 — any authenticated user can read any profile (accepted, narrowed)

`GET /v1/users/:id` serves any account's `id`, `email`, `name`, `role`, `provider`
and `avatarUrl` to any authenticated caller. This is deliberate in this codebase —
`get-order.query.ts` says so in passing, noting that unlike an order id, nothing
about a user id is secret to somebody who already knows the account exists — and
it is what makes a user directory work.

It is still a row on this table, because it is a row on a real assessment. What
changed is the blast radius: the response is now a written field list, so the
decision is "publish these six fields to authenticated callers" rather than
"publish the row and hope". An application that should not have a directory
tightens it in one place: give `GetUserQuery` the requester, exactly as
`GetOrderQuery` has one.

## Running it

```bash
pnpm test:e2e -- test/owasp-api-top10.e2e-spec.ts   # the 33 paired assertions
pnpm test -- route-inventory                        # the API9 checker's own teeth
```

The API9 checker is unit-tested separately and deliberately. Run against the real
application it reports nothing, which is the outcome everyone wants and also the
outcome a checker that never reports anything produces — so
[`route-inventory.spec.ts`](../src/common/swagger/route-inventory.spec.ts) shows it
tables written to be wrong in one specific way each, including an exemption that
outlived the route it was written for.
