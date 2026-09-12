# Telemetry: traces, metrics and logs

Everything in `src/telemetry/`. One SDK, installed before the application
exists, producing three signals that share one identity: a trace id that is on
the span, on the log line, and in the header of every message this service
sends.

The point of the exercise is one question — _what happened to this request?_ —
being answerable when the answer spans a database transaction, a poller, a
broker and another process. No single signal answers it. A trace shows the
shape; a log line says what the code thought it was doing; a metric says whether
this is normal. They are worth having together and much less useful apart, which
is why they are configured together and share a resource.

## Off by default, and genuinely off

`OTEL_EXPORTER` defaults to `none`, and `none` does not mean "collect and
discard". `startTelemetry` returns immediately without registering a tracer
provider, a meter provider, a logger provider, a propagator or any
instrumentation. The `@opentelemetry/api` globals stay at their built-in no-op
implementations, so:

- `tracerFor("outbox").startActiveSpan(...)` runs the callback and allocates no
  span;
- `meterFor(...).createCounter(...).add(1)` is an empty method;
- `injectTraceContext(headers)` adds nothing, so no message carries a
  `traceparent` describing a trace that does not exist;
- `TelemetryLogger` is exactly Nest's `ConsoleLogger`.

That is what makes it safe for the manual instrumentation to be unconditional.
Nothing in this codebase asks "is telemetry on?" before recording something,
because the API already answers that question for free.

| `OTEL_EXPORTER` | What happens                                                    |
| --------------- | --------------------------------------------------------------- |
| `none`          | nothing is installed (default)                                  |
| `console`       | spans, metrics and log records to stdout; refused in production |
| `otlp`          | OTLP/HTTP to `OTEL_EXPORTER_OTLP_ENDPOINT`                      |

## Why the SDK starts before Nest

`src/telemetry/register.ts` is the **first** import in `main.ts`, ahead of
`reflect-metadata`:

```ts
import { telemetry } from "./telemetry/register";
import "reflect-metadata";
```

`HttpInstrumentation` and `ExpressInstrumentation` work by patching the exports
of `http` and `express` through a `require` hook. A module loaded before the
hook is installed is a module that is never instrumented — so telemetry set up
inside a Nest provider, which is the obvious place, would run after the whole
application graph has been constructed and produce an SDK that reports the
manual spans in this repository and no HTTP at all.

That is also why `register.ts` reads `process.env` directly through
`telemetryEnvSchema` rather than asking `ConfigService`: at that point there is
no container. The same field declarations are spread into `envSchema`
(`telemetryEnvShape`) and the same cross-field rules are applied by both
(`refineTelemetryEnv`), so the two paths cannot disagree about what a valid
sampling ratio is. `telemetry.env.spec.ts` asserts that they don't.

## Sampling: parent-based, ratio at the root

```ts
new ParentBasedSampler({ root: new TraceIdRatioBasedSampler(ratio) });
```

`OTEL_TRACES_SAMPLER_ARG` applies **only where this service starts a trace**. A
request that arrives with a `traceparent` inherits that trace's sampled flag
instead of drawing again.

Sampling independently at each hop is the mistake this prevents, and it is worth
being concrete about why: three services each keeping 10% of what they see
produce a trace that is complete 0.1% of the time. The rest are traces with
holes in them — a gateway span whose downstream call apparently went nowhere.
The decision is made once, at the root, and travels in the header.

## Trace context, and the two places it would otherwise be lost

Inbound and outbound HTTP need no help: `instrumentation-http` extracts
`traceparent` from a request and `instrumentation-undici` puts one on every
`fetch` — which is every outbound call this service makes, since
`common/http/json-http.ts` uses `fetch` exclusively.

The two seams that _do_ need help are both in this repository's own
architecture.

### 1. The outbox row

An event is staged inside the request that caused it, in that request's
transaction. It is published later — seconds or minutes — by a poller, in
whichever replica's drain wins the row, under a trace context that describes
the poll and nothing else.

So the request's context is written down with the row:

```prisma
traceparent String?
tracestate  String?
```

`TransactionalOutbox.stage` captures it with `currentTraceCarrier()`, for the
same reason it stamps `occurredAt` and `eventId` there rather than at delivery:
the facts about an event belong to the moment it happened.
`BrokerOutboxPublisher` reads it back and starts its producer span with that
context as the **parent**, not the ambient one.

Without this, every event in the system would hang off a timer. The trace would
begin at the poll, and the request that caused the event would be unreachable
from the message — which is the one link the whole exercise is for.

Both columns are nullable and expected to be. Rows staged before the migration,
and rows staged while telemetry was switched off, have no context to record;
publishing one starts a fresh trace rather than failing or inventing a parent.

### 2. The message on the wire

`encodeDomainEvent` injects the **active** context — which, at that point, is
the producer span above — into the message headers, under the W3C names:

```
traceparent: 00-<trace id>-<span id>-01
tracestate:  <opaque>
```

No `event-` prefix, unlike every other header the codec writes, because unlike
every other header these are not this repository's invention. A consumer in
another language, with an SDK that has never heard of this service, finds its
parent by looking for exactly this key.

`DomainEventConsumer` extracts it onto `ROOT_CONTEXT` — not onto the active
one, which at that point is whatever the broker client left behind — and opens
a `CONSUMER` span under it.

The result, asserted end to end in `src/messaging/trace-propagation.spec.ts`:

```
POST /v1/users                 (server span, from instrumentation-http)
└─ domain-events send          (producer span, parented on the stored context)
   └─ domain-events process    (consumer span, parented on the header)
      └─ …whatever the subscribers do
```

`headerCarrierGetter` folds case on the way in. The recommendation defines the
field names in lower case and requires receivers to accept them
case-insensitively, and a producer in another language may well write
`Traceparent`; an exact-match lookup misses it, the consumer's span is orphaned,
and the trace splits in two at the service boundary with nothing reporting an
error.

## Logs

`TelemetryLogger` replaces Nest's logger in `main.ts` and writes to **both**
stdout and the OpenTelemetry logs pipeline.

Both, because either alone is worse. Only stdout leaves the third pillar to a
sidecar that scrapes text back into structure, which works until a message
contains a newline. Only the pipeline means a service whose logs vanish when the
collector is unreachable, and an operator with no `kubectl logs`.

The trace ids on a log record are stamped by the SDK from the active context
rather than written by this class. Setting them by hand would produce the same
three fields under names of our own invention, which no backend joins on.

The access log in `LoggingInterceptor` is the exception and does it explicitly:

```json
{ "correlationId": "…", "method": "GET", "statusCode": 200, "trace_id": "…", "span_id": "…" }
```

snake_case, unlike every other field on that line, because those two names
belong to the logs data model — a collector tailing stdout joins the line to its
trace by finding exactly those keys. They are `null` when the request is not
being recorded, which is honest: omitting them would leave a collector unable to
tell a dropped trace from a parse failure.

The correlation id goes the other way. `LoggingInterceptor` puts it on the span
the instrumentation has **already** opened for the request — the Express
request-handler span — as `app.correlation_id`, rather than opening one of its
own. So an operator holding an `x-correlation-id` out of a bug report can find
the trace, and an operator holding a trace can find every log line that names
it, without a redundant span that would deepen every trace and agree with the
instrumentation's about everything.

## Metrics

Most of what matters comes free: `instrumentation-http` emits server and client
duration histograms, which is the RED data for every HTTP route without a line
of code here.

Two instruments are written by hand, for the two things no instrumentation can
see:

| Instrument                   | Why                                                                      |
| ---------------------------- | ------------------------------------------------------------------------ |
| `outbox.events.drained`      | `disposition="dead"` is the only outbox failure that is otherwise silent |
| `messaging.process.duration` | a dead-lettered message is a _successful_ return from the handler        |

Both are created in their owner's constructor rather than at module scope. An
instrument takes the meter provider that is installed _when it is created_, and
one taken from the API's no-op meter stays no-op for the life of the process —
so a module-level instrument would be created while the file is first required,
which in a test is before any provider exists.

The instrumentation scope is `boilerplate-nestjs-api/<component>`
(`tracerFor`, `meterFor`). A scope is how a backend tells this service's own
instrumentation apart from a library's, and one flat name for the whole service
would make the outbox's numbers indistinguishable from the consumer's on the day
one of them starts misbehaving.

There is deliberately no Prometheus endpoint here — that is the next item in
`SPEC.md` Phase 11, and it is a different decision (a pull-based scrape with its
own exposition format) rather than a second exporter bolted onto this one.

## What is deliberately not traced

`UNTRACED_PATH_PREFIXES` drops `/v1/health`, `/health`, `/docs` and
`/favicon.ico` on the way in. A liveness probe runs every few seconds forever
and has never been what somebody opened a trace viewer to find; left in, probes
are the overwhelming majority of spans in a quiet service, and the sampling
ratio spends itself on them instead of on the one interesting request in the
window.

The **outgoing** side is not filtered. An outbound call this service makes is
always something somebody will want to see.

## Shutdown

`main.ts` flushes after `app.close()`, not before and not in parallel: shutdown
hooks are where the relay finishes its last drain and the consumer leaves its
group, and both produce spans and log records. Flushing first would export
everything except the part of the lifecycle that is hardest to observe any other
way.

Each provider's shutdown is bounded by `OTEL_SHUTDOWN_TIMEOUT_MS` and the three
are settled rather than `all`-ed, so a collector that has stopped answering
cannot turn a rolling deploy into the force-exit path in `main.ts`.

## Configuration

See `.env.example` for the full annotated list. The one to be careful with:

**`OTEL_EXPORTER_OTLP_HEADERS` is a credential.** It is how a hosted collector
is authenticated. It belongs in the secret store next to `JWT_SECRET`, never in
a checked-in `.env`. `parseOtlpHeaders` splits on the _first_ `=` only — base64
padding is `=`, and splitting on every occurrence truncates a `Basic` token into
something that authenticates nothing — and throws on a malformed entry rather
than dropping it, because an export pipeline that silently loses its own
authentication fails at the far end, in somebody else's logs.

## Semantic conventions

`src/telemetry/semconv.ts` declares the `messaging.*` attribute names as
constants rather than importing them. The package publishes experimental
attributes from an `/incubating` subpath declared through its `exports` map, and
`exports` is only consulted under `moduleResolution: node16` or `bundler`; this
project compiles to CommonJS with the classic `node` resolver. Changing the
resolver for three constants would change how every dependency resolves.

The cost is that the compiler will not notice a rename, and the experimental
attributes do get renamed — `messaging.kafka.message.offset` became
`messaging.kafka.offset` in 1.27. **Re-check that file when the package is
upgraded**; the version it was taken from is recorded in it.

Names this repository invented carry the `app.` prefix the specification
reserves for exactly that — `app.correlation_id`, `app.event.name`,
`app.messaging.outcome`, `app.outbox.disposition` — so nobody greps the
conventions for them and comes back empty.

## What this is still not

- **No span for a database query.** Prisma 7 has its own tracing integration and
  it is a decision of its own (it needs the Prisma instrumentation and a
  preview feature); the outbox's SQL is therefore inside its caller's span
  rather than in one of its own.
- **No trace context on a BullMQ job.** The queue is the third asynchronous seam
  in this service and it has the same problem the outbox had; it does not yet
  have the same fix.
- **No trace context through the saga's stored steps.** A saga instance survives
  a crash and is resumed by a poller, so a resumed step is in a trace of its
  own — the same shape of gap the outbox columns close, and closeable the same
  way.
- **No tail sampling.** The decision is made at the root, before anything is
  known about how the request went, so a rare slow request is kept only if it
  happened to win the draw. Tail sampling is a collector-side feature and needs
  one deployed.
- **Baggage is propagated but nothing sets any.** `W3CBaggagePropagator` is
  registered so a value set upstream survives this hop; no code here adds to it.
