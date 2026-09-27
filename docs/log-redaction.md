# PII redaction in logs

Logs are the easiest place in a service to leak personal data and the hardest
place to un-leak it. A log line is copied to stdout, scraped into a cluster log
store, shipped to a vendor, retained for months and read by more people than any
database row — and unlike a row, there is no `UPDATE` that takes it back. So the
question this module answers is not "what should we hide?" but "what are we
willing to write down?"

The answer is a **processor chain** in front of a single logger, with an
**allowlist** as the last processor in it.

```
Logger.log(…) ──▶ toLogEvent ──▶ scrubMessage ──▶ redactFields(allowlist) ──▶ stdout
                                                                          └─▶ OTLP
```

## Why an allowlist

A denylist — `password`, `email`, `ssn` — fails on the next field somebody adds.
`emailAddress` is not `email`. `dob` is not `dateOfBirth`. `taxId`,
`nationalInsuranceNumber`, `homeAddress` and `cardNumber` are each one commit
away from existing, and a denylist is silent about every one of them. Its failure
mode is a leak nobody observes.

An allowlist fails the other way. A field that nobody has thought about is
redacted, and the way it becomes visible is a diff that adds it to
`DEFAULT_ALLOWLIST` — a line a reviewer can object to. The cost is real: a field
you wanted is missing until you say so. That friction is the control.

## Why paths and not key names

The allowlist is a list of **paths**, not of key names:

| Pattern       | Admits                                |
| ------------- | ------------------------------------- |
| `userId`      | the top-level `userId`                |
| `order.id`    | `id` inside `order`, and nowhere else |
| `items[].sku` | `sku` in every element of `items`     |
| `counts.*`    | any single key under `counts`         |

"Is a field called `name` safe?" has no answer — `order.name` is a product and
`customer.name` is a person. A key-name allowlist admits both the moment it
admits either.

Three properties of the matcher are load-bearing:

- **No prefix matching.** `order` does not admit `order.id`. Prefix matching is
  the one behaviour an allowlist must not have: it turns "log the order" into
  "log everything anybody ever nests under the order", silently, on a commit
  that adds a field. Subtrees are spelled out one path at a time.
- **Array indices collapse.** Every element of `items` shares the path
  `items[].sku`. An allowlist written against indices would admit the first
  element and redact the rest, which looks like data corruption and gets
  debugged as one.
- **Matching is on segments, not on the rendered string.** A caller who controls
  a key controls the rendered path: `{"a.b": …}` renders exactly like a nested
  `{a:{b:…}}`. Splitting the rendered path on `.` would let an attacker-chosen
  key reach an allowlist entry written for somebody else's subtree.

## What is redacted, and what survives

Only the **value** is replaced, and the **key is kept**:

```json
{ "userId": "u-91f2", "customerEmail": "[redacted]", "query": { "code": "[redacted]" } }
```

Keeping the key is the point. `"customerEmail":"[redacted]"` says the field
exists, was populated, and is not allowlisted — three facts that make the next
change obvious. Dropping it would leave a line that looks complete and is not,
and the difference between "no email was involved" and "an email was involved
and you may not see it" is what an incident turns on.

The marker carries no length, no hash and no prefix. A redacted value's length
helps anyone guessing at it, and a stable hash of a low-cardinality field — a
postcode, a date of birth — is reversible by enumeration. Correlating two
occurrences of one value is what `userId` is allowlisted for.

Other rules:

- **Structure survives.** Objects stay objects and arrays keep their length, so
  `{"items":[{"sku":"[redacted]"},{"sku":"[redacted]"}]}` still says the order
  had two lines.
- **`null` and `undefined` pass through.** They are the absence of data, so there
  is nothing to disclose, and "not set" versus "set and withheld" is a
  distinction an operator needs on every line.
- **Type does not decide; the path does.** A number is a salary. A boolean is one
  bit that can still be a diagnosis.
- **Class instances are never walked.** Walking one runs its getters, which is
  somebody else's code inside the logging path, on an object that may lazily
  fetch the thing being redacted. An instance is admitted or redacted whole.

## The message is weaker than the fields — log fields

This is the central caveat, and it is not a bug that will be fixed later.

A `LogEvent` has two halves. `fields` is a map, so the allowlist can decide per
field. `message` is one string: there is no key to look up, and it is the one
part of the line that must survive for the line to be worth keeping. It gets the
credential scrubber and nothing else.

So:

```ts
// Ships the address. `message` is not allowlisted.
this.logger.log(`order placed for ${customer.email}`);

// Redacted, and a reviewer can see the decision.
this.logger.log({ message: "order placed", userId, customerEmail: customer.email });
```

Passing an object is also what makes the line queryable rather than grep-able,
which is the same reason structlog exists.

## The second layer: credentials inside fields you kept

The allowlist decides which fields are logged. It cannot decide what is inside
one — and `path` is allowlisted, because an access log without a path is not an
access log. `path` is exactly where this service's worst leak lived:

```
GET /v1/auth/google/callback?code=4/0AXhV9kcQr7Tg…
```

That `code` is a single-use OAuth authorisation code, exchangeable for the
person's access and refresh tokens, and it was written to stdout on every
successful Google sign-in. No allowlist catches it, because the field is one
somebody was right to allow.

Two things fix it. `LoggingInterceptor` now splits the request target into `path`
and a `query` **object**, so each parameter is a field the allowlist decides on
by name — `query.page` survives, `query.code` does not, and nobody had to
predict `code`. And `scrubSecrets` removes credentials from any allowlisted
string: query-parameter values (names kept), compact JWTs, `Bearer`/`Basic`
material, and PEM private-key blocks.

`scrubSecrets` is deliberately **not a PII detector**. Detecting personal data by
pattern is a losing game — a name matches nothing and an address matches
everything, and a regex that finds 90% of email addresses fails silently one time
in ten while reading as though it works. PII is the allowlist's job. A credential
is the opposite case: each pattern has a structural marker that is close to
unmistakable, and the cost of a false positive is one unreadable value against an
account for a miss.

## Failing closed

A processor that throws has not finished deciding what was safe, so the record
cannot be emitted. Both obvious fallbacks are wrong:

- Emitting the original is fail-**open**. The redactor's own bug becomes the
  disclosure, on the record that was unusual enough to break it — which is
  disproportionately the interesting one.
- Emitting nothing loses the line silently. A redactor throwing on every record
  would present as a service that had stopped logging, with the cause invisible
  precisely because the evidence is what is missing.

So a failure emits a **substitute**: level raised to `error`, no content, and the
thrown error's _type_ — a programmer's word — so the bug is findable. The error's
`message` is omitted, because a thrown message routinely quotes the value that
caused it, which here is the value being redacted. A second copy goes to stderr
directly, for the case where the logging pipeline is itself what is broken.

A chain that fails at step three does not emit what steps one and two produced:
those are intermediate states, and if the redacting processor has not run yet,
the intermediate **is** the raw record.

## Both sinks, or neither

`TelemetryLogger` writes to stdout and to the OpenTelemetry logs pipeline, and
the chain runs **before either**. Redacting only the OTLP record would leave the
stdout copy — the one an operator reads with `kubectl logs`, the one scraped into
whatever the cluster retains, and the copy that exists when the collector does
not — in the clear. Two sinks with two ideas of what is sensitive is the same as
no redaction, and harder to notice, because the pipeline an auditor is shown
looks correct.

There is one logger, and `app.useLogger()` means every `new Logger()` in the
application goes through it. That is what makes one seam sufficient.

## Configuration

```bash
# On by default. Refused in production.
LOG_REDACTION_ENABLED=true

# Extra paths to log in the clear, comma-separated.
LOG_REDACTION_EXTRA_ALLOWLIST=order.currency,query.region
```

`LOG_REDACTION_ENABLED` defaults to **on**, unlike every optional backend in this
codebase. Those are capabilities, and a clean clone should boot with none
configured; this is a control. It is **refused in production**, because it is the
setting whose consequence is invisible from inside the process and expensive
outside it. To log a field in production, name it in the extra allowlist — a
decision in a diff rather than a blanket.

`LOG_REDACTION_EXTRA_ALLOWLIST` exists so that needing a field is a
configuration change in front of an operator rather than a release. Every entry
is validated at boot: a malformed one is **refused**, not dropped, because a
silently discarded entry is a field an operator believes is being logged and
which is not there on the day they look. A pattern beginning `*` is refused too
— `LOG_REDACTION_EXTRA_ALLOWLIST=*` parses perfectly, admits every top-level
field, and reads in a manifest like configuration rather than like the disabled
redactor it is.

Both settings are read twice: by `envSchema`, and by the logger itself. The
logger is installed before `ConfigService` exists, because `bufferLogs: true`
replays the whole boot sequence through it and those lines need redacting too.
The logger's own read **fails closed** — an environment it cannot parse produces
full redaction, and `envSchema` is left to report the problem properly.

## Limits

Known, and deliberate:

- **The message is not allowlisted.** Covered above. It is the single most likely
  way PII still reaches a log from this service.
- **Guard rejections are not access-logged at all.** Nest runs guards before
  interceptors, so a request refused by `JwtAuthGuard` or `GoogleAuthGuard` never
  reaches `LoggingInterceptor` and produces no line. That is an observability
  gap rather than a redaction one, and it is why
  `test/log-redaction.e2e-spec.ts` asserts against an unguarded route.
- **Path segments are not redacted.** `path` is allowlisted whole, so a route
  that puts personal data in a segment (`/v1/users/by-email/ada@example.com`)
  would log it. Nothing here has such a route; the mitigation is route design,
  not this module.
- **A key containing a `.` cannot be allowlisted.** The grammar has no way to
  spell one, so such a field is always redacted. The safe direction, and nothing
  here logs one.
- **Key names are never redacted.** Keys are developer-chosen identifiers, not
  data — except under a `*` pattern, where they may be attacker-chosen. Use `*`
  only where the keys are known-safe.
- **No per-tenant or per-environment allowlists**, no sampling or rate-limiting
  processor (the chain supports dropping; nothing uses it), and nothing counts
  how often a field is redacted — which would be the cheapest way to notice that
  a new field is being logged a million times a day.
- **Structural caps are constants**, not settings: depth 8, 512 nodes per record,
  2048 characters per string. Exceeding one yields `[truncated]`.
- **Nothing redacts the database, the traces or the metrics.** Span attributes
  and metric labels go out unredacted; this module is about log records. See
  `docs/field-encryption.md` for data at rest.
