# Outbound HTTP resilience

Every call this service makes to somebody else's API — Stripe, PayPal, Twilio,
Expo — goes through `ResilientHttpClient`
(`src/common/http/resilient-http.client.ts`). It puts a circuit breaker and a
concurrency cap in front of each dependency, a full-jitter retry ladder around
the calls that can safely take one, and a hard deadline around the whole thing.

Each mechanism answers a different failure.

| Mechanism | The failure it is for                                                    |
| --------- | ------------------------------------------------------------------------ |
| Ladder    | over by the time you look again: a dropped connection, a node restarting |
| Breaker   | a dependency that is down, and calls that should not be sent at all      |
| Bulkhead  | a dependency that is slow, and calls that should not all be sent at once |
| Deadline  | a call that is still going long after anybody had a use for the answer   |

The ladder and the breaker are two halves of the same argument. Retrying into a
real outage is worse than useless: it multiplies the load on something already
failing and converts a dependency's outage into this service's, because every
worker is parked waiting on it.

The bulkhead is there because the breaker cannot see the slow case. A breaker
reads history, and history is made of calls that have finished. A dependency
answering in nine seconds, just inside its ten-second timeout, produces no
failures at all — every call eventually succeeds — while each one occupies this
process for nine seconds. Capping concurrency is the only thing in the list that
bounds that, and the deadline is what stops a single call from spending more of
somebody else's budget than they have.

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

| Failure                                                  | Thrown                      | Status |
| -------------------------------------------------------- | --------------------------- | ------ |
| DNS, refused connection, socket hang-up, attempt timeout | `HttpTransportError`        | 502    |
| The breaker is open, so nothing was sent                 | `HttpCircuitOpenError`      | 503    |
| The bulkhead is saturated, so nothing was sent           | `HttpBulkheadRejectedError` | 503    |
| The call's whole budget went without an answer           | `HttpDeadlineExceededError` | 504    |

All are `HttpException`s, so `AllExceptionsFilter` renders them without a
controller having to translate anything, and a network failure reaching a caller
is a 502 rather than the 500 a raw `TypeError` from `fetch` would have produced.

The two 503s are deliberately distinct classes. An open breaker says the
dependency is failing; a full bulkhead says it is slower than this service has
capacity for. Those want different fixes, and one error for both would make them
indistinguishable in the only two places anybody looks — the log line and the
response body.

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

## The bulkhead

`Bulkhead` (`src/common/bulkhead/bulkhead.ts`) is a counting semaphore with a
bounded FIFO wait queue, one instance per dependency name, created on that
dependency's first call alongside its breaker.

A call takes a permit, sends its request, and gives the permit back. When all
`HTTP_BULKHEAD_MAX_CONCURRENT` permits are held, the next call queues; when
`HTTP_BULKHEAD_MAX_QUEUED` callers are already queued, or a queued caller has
waited `HTTP_BULKHEAD_QUEUE_TIMEOUT_MS`, it is refused with a 503 and nothing is
sent.

Both bounds matter. An unbounded queue converts a concurrency problem into a
memory problem and hides it until the process dies; a deep one fills with
requests whose callers have already given up. A queue at all is worth having
because the burst that clears in a moment is the common case, and refusing it
outright would make the bulkhead itself the outage.

**Why it is not opossum's `capacity`.** The previous iteration of this page said
that was where bulkheads would go. Reading opossum 10's `circuit.js` ruled it
out on two counts:

- It calls `semaphore.test()`, which never waits. There is no queue, so a burst
  one call over the cap is refused rather than absorbed.
- A refusal is routed through `handleError`, which lands it in `stats.failures`.
  The error percentage is `failures / fires`, so enough of our own back-pressure
  would open the breaker — taking out a dependency that has answered every
  request correctly, for the whole reset timeout. Our admission decisions must
  not be evidence about somebody else's health, and there is a test asserting
  exactly that: six bulkhead rejections against a volume threshold of five leave
  the breaker closed with zero failures.

**Where it sits.** Outside the breaker and inside the ladder:

```
request()
└── for each attempt
    └── bulkhead permit          ← acquired and released per attempt
        └── breaker
            └── fetch
```

Outside the breaker, because a permit stands for a call this service is holding
open and an open breaker holds nothing — a rejection there is instant, so it
turns permits over rather than occupying them.

Inside the ladder, because a backoff sleep holds no socket either. A permit kept
across one would cap real concurrency below the configured figure and let a
failing dependency's own retries crowd out its healthy calls.

## The deadline

`HTTP_REQUEST_DEADLINE_MS` is a hard ceiling on one `request()` call, covering
everything it can spend time on: waiting for a permit, every attempt, and every
sleep between them. `deadlineMs` on `HttpRequestOptions` overrides it for a
caller that has a tighter budget of its own.

It is enforced rather than hoped for:

- Each attempt's socket timeout is the smaller of `timeoutMs` and what is left
  of the budget, re-read after the queue wait — so a ten-second attempt inside a
  budget with two seconds left gets two.
- The ladder stops when the next sleep would not fit in what remains, instead of
  sleeping past the deadline to make an attempt that cannot finish.

When the budget runs out the caller gets the same thing it would get from a
spent ladder: the last response, if there is one. `HttpDeadlineExceededError`
(504) is thrown only when the budget went with no response at all, and it
reports how many attempts fitted — which is the difference between a dependency
that is slow and one that is failing fast and being retried.

`HTTP_REQUEST_DEADLINE_MS` must be greater than
`HTTP_BULKHEAD_QUEUE_TIMEOUT_MS`, and the config refuses to boot otherwise.
Otherwise every call under contention waits out the full queue timeout, is
admitted, finds nothing left of its budget, and gives up without sending
anything: a 504 for every request, however healthy the dependency is.

`client.snapshot()` reports each dependency's breaker state and counters
alongside its bulkhead's occupancy and rejections, for a health indicator or a
metrics scrape. They are read together — a saturated bulkhead with a closed
breaker is a slow dependency, and the same bulkhead with an open breaker is a
queue of calls waiting to be told the circuit is open.

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
| `HTTP_BULKHEAD_MAX_CONCURRENT`           | `20`    | calls one dependency may have in flight at once              |
| `HTTP_BULKHEAD_MAX_QUEUED`               | `20`    | callers that may wait for a permit; `0` is pure fail-fast    |
| `HTTP_BULKHEAD_QUEUE_TIMEOUT_MS`         | `1000`  | how long a call waits for a permit before a 503              |
| `HTTP_REQUEST_DEADLINE_MS`               | `25000` | hard ceiling on one call: queue wait, attempts and sleeps    |

Two of these are checked against each other at boot. The window must be at least
the bucket count, and the request deadline must exceed the queue timeout; the
config refuses to boot otherwise. Opossum divides one by the other with integer division and rotates a
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

**Nothing hands a caller's deadline down automatically.** `deadlineMs` exists and
is respected, but every caller has to pass it. A saga step is bounded by
`SAGA_STEP_TIMEOUT_MS` (10s by default) and its payment call still defaults to
the 25s policy budget, so the step's wait is cut off first: the saga retries on
its own ladder, every participant is idempotent on the step's key, and the
outcome is correct — but the budget is spent twice over. The general fix is a
request-scoped deadline the client reads for itself rather than an argument each
call site remembers, which wants the `AsyncLocalStorage` context that the
OpenTelemetry item will introduce. Until then, pass `deadlineMs` explicitly from
any caller that has a deadline of its own.

**The bulkhead is per instance, not per fleet.** `HTTP_BULKHEAD_MAX_CONCURRENT`
caps one process, so the load a dependency actually sees is that times the
replica count. Sizing it means dividing the dependency's real budget by the
number of replicas, and nothing here notices when that number changes. A
distributed cap would need shared state on the hot path of every outbound call,
which is a worse trade than sizing the local one conservatively.

**Nothing exports these counters yet.** `snapshot()` has everything a dashboard
needs — breaker state, in-flight and queued counts, both rejection tallies — and
no health indicator or metrics endpoint reads it. Those are the next two items in
`SPEC.md`.
