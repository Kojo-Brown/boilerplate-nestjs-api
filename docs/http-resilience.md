# Outbound HTTP resilience

Every call this service makes to somebody else's API — Stripe, PayPal, Twilio,
Expo — goes through `ResilientHttpClient`
(`src/common/http/resilient-http.client.ts`). It puts a circuit breaker in front
of each dependency and a full-jitter retry ladder around the calls that can
safely take one.

The two mechanisms answer different failures. The ladder is for the failure that
is over by the time you look again: one dropped connection, one 503 from a
node that was being replaced. The breaker is for the failure that is not: a
dependency that is down, or so slow that every request against it is a request
this service is holding open for ten seconds and then losing. Retrying into that
is worse than useless — it multiplies the load on something already failing and
converts a dependency's outage into this service's, because every worker is
parked waiting on it.

## The shape of a call

```ts
const response = await this.http.request(
  "stripe", // the dependency: one breaker per name
  `${this.baseUrl}/v1/payment_intents`,
  { method: "POST", headers, body },
  { idempotent: true }, // this POST carries an Idempotency-Key
);
```

`request()` keeps the contract the raw `requestJson` had, which is why the
adapters did not change shape when it landed: **a status is data**. Any response
comes back as an `HttpJsonResponse`, including a 500 after the ladder is spent,
because the adapters read the upstream's error body to tell a declined card from
a dead gateway and that decision belongs to them. Only a call that produced no
response at all throws:

| Failure                                                  | Thrown                 | Status |
| -------------------------------------------------------- | ---------------------- | ------ |
| DNS, refused connection, socket hang-up, request timeout | `HttpTransportError`   | 502    |
| The breaker is open, so nothing was sent                 | `HttpCircuitOpenError` | 503    |

Both are `HttpException`s, so `AllExceptionsFilter` renders them without a
controller having to translate anything, and a network failure reaching a caller
is a 502 rather than the 500 a raw `TypeError` from `fetch` would have produced.

## What counts as a failure

Only responses that describe a condition which can pass:

- **5xx** — the dependency broke.
- **408** and **429** — the dependency said "later".

Everything else in the 4xx range is this service sending something wrong, and it
is neither retried nor counted against the breaker. That second half matters
more than it looks: `find()` on a payment that does not exist is a 404, and a
run of them is a _healthy_ dependency answering correctly and promptly. A
breaker that opened on those would be causing an outage rather than containing
one.

## What gets retried

A retry is a second attempt at a request whose first outcome is **unknown** —
the connection died, a gateway answered 502 — which is exactly the case where
the upstream may well have processed it. So the ladder is opt-in:

- Safe methods (`GET`, `HEAD`, `OPTIONS`) are retried by default.
- Anything else is retried only when the call passes `idempotent: true`.

The bar for passing it is an idempotency key on the request, or an operation
that creates nothing:

| Call                                             | Retried | Why                                                                |
| ------------------------------------------------ | ------- | ------------------------------------------------------------------ |
| `StripePaymentProvider.authorize()`              | yes     | sends `Idempotency-Key`                                            |
| `StripePaymentProvider.capture()`, `refund()`    | no      | no key; a replayed refund is a second refund                       |
| `PaypalPaymentProvider.authorize()`, `capture()` | yes     | send `PayPal-Request-Id`                                           |
| `PaypalPaymentProvider` token mint               | yes     | exchanges credentials for a token and creates nothing              |
| `PaypalPaymentProvider.refund()`                 | no      | no request id                                                      |
| Any `find()`                                     | yes     | `GET`                                                              |
| `SmsNotificationChannel.send()`                  | no      | Twilio delivers every message it accepts; a retry is a second text |
| `PushNotificationChannel.send()`                 | no      | same, for every device in the batch                                |

Both payment adapters read the flag off the header rather than taking it as a
separate argument — `"Idempotency-Key" in extraHeaders` — so the claim and the
thing that makes it true cannot drift apart.

Calls that are not retried still go through the breaker. Protection and
repetition are separate decisions, and only one of them can send a second text
message.

## The ladder

Full jitter, from `nextAttemptDelayMs` in `src/common/backoff` — the same
formula the outbox relay and the Kafka consumer use, and for the same reason. An
upstream that fails every in-flight request fails them at almost the same
instant, so a deterministic ladder schedules the entire fleet's retries for the
same millisecond and the recovery attempt arrives as a thundering herd against
something that has just come back up.

`Retry-After` overrides the draw when the upstream sends one, in either RFC 9110
form: the rate limiter knows when its window rolls over and we are guessing. A
jitter draw over `baseMs` is added on top, because every client throttled in the
same second is handed the same number and obeying it exactly rebuilds the herd.
A hint longer than `HTTP_RETRY_MAX_DELAY_MS` ends the ladder instead of being
honoured — somebody is waiting on this request, and parking it for the five
minutes a rate limiter can ask for is a worse answer than the 429 they can act
on.

## The breaker

[opossum](https://github.com/nodeshift/opossum), one instance per dependency
name, created on that dependency's first call. One breaker for "outbound HTTP"
would let Twilio being down stop payments, which is the failure the pattern
exists to prevent.

It opens when more than `HTTP_BREAKER_FAILURE_THRESHOLD_PERCENT` of the calls in
the rolling window failed, provided the window holds at least
`HTTP_BREAKER_VOLUME_THRESHOLD` of them — without that floor, the first call of a
quiet minute failing is a 100% failure rate over a sample of one. While open,
calls are rejected without being sent; after `HTTP_BREAKER_RESET_TIMEOUT_MS` it
admits a single probe and closes again if that probe succeeds.

Two deliberate choices in how it is wired:

**The ladder is outside the breaker.** The breaker wraps one attempt, so every
attempt is counted, and the ladder stops the moment the breaker opens. Nesting
them the other way would record one call's three attempts as a single failure —
a third of the evidence the threshold is calibrated for — and would leave a
caller retrying against an open breaker until its budget ran out, which costs
nothing and tells it nothing.

**Opossum's own `timeout` is off.** The request already carries
`AbortSignal.timeout`, which aborts the socket. Opossum's timer only stops
_waiting_ for the promise: the request stays in flight, its side effect still
happens, and the connection is still held. Two deadlines where one of them
cannot cancel anything is how a "timed out" call ends up having succeeded.

`client.snapshot()` reports each dependency's state and counters, for a health
indicator or a metrics scrape.

## Configuration

All of it is validated by `envSchema` at boot, and the defaults are the ones a
clean clone runs.

| Variable                                 | Default |                                                              |
| ---------------------------------------- | ------- | ------------------------------------------------------------ |
| `HTTP_RETRY_MAX_ATTEMPTS`                | `3`     | attempts per call, the first included; `1` disables retrying |
| `HTTP_RETRY_BASE_MS`                     | `200`   | delay before the second attempt, before jitter               |
| `HTTP_RETRY_MAX_DELAY_MS`                | `2000`  | ceiling on the delay, and the longest `Retry-After` honoured |
| `HTTP_BREAKER_FAILURE_THRESHOLD_PERCENT` | `50`    | failure rate above which the breaker opens                   |
| `HTTP_BREAKER_VOLUME_THRESHOLD`          | `10`    | calls the window must hold before that rate counts           |
| `HTTP_BREAKER_ROLLING_WINDOW_MS`         | `10000` | how much history the rate is computed over                   |
| `HTTP_BREAKER_ROLLING_BUCKETS`           | `10`    | buckets the window advances through                          |
| `HTTP_BREAKER_RESET_TIMEOUT_MS`          | `30000` | how long an open breaker rejects before probing              |

The window must be at least the bucket count, and the config refuses to boot
otherwise. Opossum divides one by the other with integer division and rotates a
bucket every interval, so fewer milliseconds than buckets floors that to zero —
a timer firing as fast as the event loop allows, on every breaker, forever. An
uneven division is fine and is not refused: it loses at most one bucket of
history.

## Why this is not the `@Retry()` aspect

`src/common/aspects` already has a `@Retry()` decorator with the same jitter, and
it is the right tool one level up — for a method whose failure is worth
repeating as a whole. It is the wrong one here for two reasons:

- **Granularity.** `StripePaymentProvider.refund()` is three HTTP calls: read the
  intent, post the refund, read it back. Retrying the method re-posts the refund.
  Retrying the call that actually failed does not.
- **Classification.** A method-level ladder sees a thrown `HttpException` and
  guesses from its status. The client sees the response — the status, the
  `Retry-After` header, whether the request carried an idempotency key — which is
  what the decisions on this page are actually made from.

## What is not here yet

There is no per-dependency concurrency cap. A dependency that is slow rather
than broken can still tie up every caller that arrives inside its timeout, and
the breaker only reacts once enough of those calls have finished failing.
Bulkheads are the next item in `SPEC.md`, and opossum's `capacity` option is
where they go.

The ladder also does not know about a deadline above it. A saga step that calls a
payment provider is bounded by `SAGA_STEP_TIMEOUT_MS` (10s by default), while
three attempts at a 10s HTTP timeout can take thirty. The step's wait is cut off
first; the saga retries the step on its own ladder, and every participant is
idempotent on the step's key, so the outcome is correct — but the budget is
spent twice over. Lower `HTTP_RETRY_MAX_ATTEMPTS` or raise
`SAGA_STEP_TIMEOUT_MS` if that matters for a given deployment.
