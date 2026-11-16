# Consumer-driven contract testing with Pact

`pnpm test:pact` is the `pact` CI job. It blocks a merge like every other gate.

```
pnpm test:pact:consumer   # writes pacts/web-storefront-orders-api.json
pnpm test:pact:provider   # replays it against this API
pnpm test:pact            # both, in that order
```

## What this gate is for

This repository already drives its own endpoints over HTTP in
`test/orders.e2e-spec.ts` — 21 specs, every guard and interceptor bound as
`main.ts` binds them. So the first question to answer is what a contract test
adds that an e2e suite does not.

An e2e suite asserts what _this_ team decided a response should look like. It is
written against the current shape and updated alongside it, which means it stays
green through changes that no consumer survives. The demonstration is one
character long:

```diff
-            version: "v1",
+            version: "1",
```

in `ResponseEnvelopeInterceptor`. Every client that reads `meta.version` breaks.
All 21 specs in `test/orders.e2e-spec.ts` pass. `pnpm test:pact:provider` fails
on three of its four interactions, naming `$.meta.version`.

That is the whole value, and it is worth being precise about it: a contract test
is not a better e2e test, and it does not find bugs. It is the only mechanism in
the build that puts _somebody else's_ requirements in front of this repository's
reviewer. Nothing else here can fail because of what a consumer needs.

## Layout

| File                                                | Side     | What it is                                                   |
| --------------------------------------------------- | -------- | ------------------------------------------------------------ |
| `test/pact/storefront-orders.client.ts`             | consumer | The orders client as the `web-storefront` consumer writes it |
| `test/pact/storefront-orders.consumer-pact-spec.ts` | consumer | Exercises that client against a Pact mock, writing the pact  |
| `pacts/web-storefront-orders-api.json`              | —        | The contract. Generated, committed, never hand-edited        |
| `test/pact/orders-api.provider-pact-spec.ts`        | provider | Replays every interaction against this API                   |

### Why the consumer is in this repository at all

It should not be. In a real setup the client and its pact test live in the
storefront's tree, its suite publishes the pact to a broker, and this repository
pulls it down — see [Introducing a broker](#introducing-a-broker). Both halves
are here because a pact has to come from somewhere, and the two honest options
are a consumer that runs or a JSON file somebody maintains by hand.

A hand-maintained pact is a fixture wearing a contract's clothes. Nothing proves
a consumer would ever send what it claims to send, nothing notices when the file
drifts from the matching rules the Pact specification actually applies, and the
first time it is wrong is the first time somebody trusts it. So the consumer is
real code, exercised by a real test, and the pact is its output.

What this costs is honesty about one thing: today the pact is written by the same
people who verify it, so it cannot discover a requirement this team has not
thought of. It can still do the thing it is here for — fail when a change breaks
a documented expectation — and that is where the gate's value is.

## How the provider side works

### The real application, on a real socket

The provider spec boots `createTestApp()` — the same fixture every e2e suite
uses — and `listen`s it on an ephemeral port, because the Pact verifier is a Rust
process that speaks HTTP to a URL rather than a library you hand a request to.
The store substitutions are the ones `test/helpers/create-test-app.ts` documents.
Nothing about the wire format is faked, which is the only part a contract is
about.

### Provider states go through the application's own endpoints

A state handler that planted a row in `InMemoryOrderStore` would be verifying the
response shape of an order no checkout ever produced. So
`"the customer has one confirmed order"` registers a customer and runs a real
checkout — priced from the catalogue, saga carried to `COMPLETED` — and returns
the id it got:

```ts
"the customer has one confirmed order": async () => {
  const token = await freshCustomer("pact-buyer");
  const placed = await http().post("/v1/orders") /* … */;
  expect(placed.status).toBe(201);
  return { orderId: placed.body.data.id as string };
},
```

The consumer cannot know that id, so it does not pretend to. The request path in
the pact is
`MatchersV3.fromProviderState("/v1/orders/${orderId}", "/v1/orders/5a4f…")`, and
the verifier substitutes what the handler returned. This is why the pact is
written at specification **V4**: V3 has no way to say "the provider chooses this".

Each handler calls `resetProviderState()` first. The warehouse and the carrier are
process-scoped and shared between interactions, so without it one interaction's
checkout is the next one's starting stock, and `"the customer has no orders"`
would be a claim about a table that still held the previous order.

### The bearer token is minted, not recorded

The pact carries `Bearer mock-access-token`. The provider's `requestFilter`
replaces it with a token minted seconds earlier by registering a user. A real
token committed to a pact file would be a credential in a repository, and an
expired one by the time anybody verified it.

The guard chain is **not** bypassed. The token is genuine, `JwtStrategy` verifies
its signature, `TenantGuard` checks its `tid`, and the orders it can see are the
ones the access policy allows. The 404-for-somebody-else's-order interaction is
in the pact precisely because that behaviour is a contract _and_ a disclosure
control: a 403 appearing there would confirm the order exists.

## Three things that will cost you an afternoon

**`requestFilter` is registered globally, ahead of Pact's own routes.** pact-js
mounts it with `app.use` on the verification proxy, so it also sees the
`POST /_pactSetup` call the verifier makes before each interaction. A filter that
treats that call like an interaction — refusing it for having no token yet — stops
the setup request from ever reaching its handler, and all four interactions are
reported as `one or more of the setup state change handlers has failed`, thirty
seconds apart, with nothing about the cause. Hence `PACT_PROXY_PATHS`.

**A header regex is matched against the whole value.** `/^application\/json/`
does _not_ match `application/json; charset=utf-8`, and the failure reads
`Expected 'application/json; charset=utf-8' to match '^application/json'`, which
looks like a broken matcher rather than a missing `$`. Anchor both ends:
`/^application\/json(;\s*charset=utf-8)?$/`.

**The verifier ignores `NO_PROXY`.** `pact-core`'s Rust HTTP client reads
`HTTPS_PROXY` and applies it to the provider URL without honouring `NO_PROXY`, so
on a machine with a proxy configured — a corporate laptop, a sandboxed
container — verification fails with whatever that proxy says about `127.0.0.1`.
The symptom is a body mismatch quoting the proxy's error page.
`silenceLoopbackProxy()` in the provider spec clears those variables for the
length of the spec and restores them after; it is sound because the only host the
spec talks to is the provider on loopback, and it is not a TLS or policy bypass
because nothing in the spec makes an outbound request.

## Writing an interaction

Two rules, both about where a contract test earns its keep and where it turns
into a snapshot test with extra machinery.

**Matchers for anything the provider generates.** Order ids, saga ids and
timestamps are the provider's to choose; pinning the examples makes the pact fail
on the second run for a reason that has nothing to do with the contract. Pin
_values_ only where the consumer genuinely depends on them — `success`,
`meta.version`, the `error` code it switches on, `failureReason` being `null` on
an order that did not fail.

**Only the fields the consumer reads.** `reservationId`, `paymentId` and
`shipmentId` are in `OrderResponseDto` and deliberately absent from the pact: the
storefront never reads them, Pact matches a response as a subset, and a field
nobody asked for stays free to change. A pact asserting the whole DTO turns every
additive change to this API into a broken consumer build, which is how teams come
to resent contract tests and then delete them.

One more, less obvious: `data: { items: [] }` is an **exact** empty array, not
`eachLike([])`. The assertion is that a customer with no orders gets a page rather
than a 404, with terminal cursor fields. `eachLike` would be satisfied by any
array at all, including one holding somebody else's order.

## Introducing a broker

Nothing in the state handlers changes. The file-based wiring is two lines:

```ts
// now
pactUrls: [PACT_FILE],

// with a broker
pactBrokerUrl: process.env["PACT_BROKER_BASE_URL"],
pactBrokerToken: process.env["PACT_BROKER_TOKEN"],
publishVerificationResult: process.env["CI"] === "true",
consumerVersionSelectors: [{ mainBranch: true }, { deployedOrReleased: true }],
```

`providerVersion` and `providerVersionBranch` are already set from `GITHUB_SHA`
and `GITHUB_REF_NAME` — inert without a broker, and what `can-i-deploy` reads
once there is one. At that point `test/pact/storefront-orders.client.ts` and its
consumer spec move to the storefront's repository, `pnpm test:pact:consumer`
leaves this one, and `pacts/` stops being committed. The broker token is a secret
and belongs in the GitHub secret store, never in `.env.example`.
