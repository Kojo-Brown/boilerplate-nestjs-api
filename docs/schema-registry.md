# Event schema contracts

Every domain event has a JSON Schema. A payload is checked against it before the
event is written to the outbox, again before it goes on the wire, and once more
when it comes back off — and a change to a schema that would break either end of
a rolling deploy fails CI rather than a consumer.

The code is in `src/schema-registry/`.

## Why a schema at all

The catalogue in `src/events/domain-event.ts` is TypeScript, and TypeScript stops
at the process boundary. Once an event is JSON on a topic, the interface that
described it is gone: the bytes are read by another build of this service, by
another service entirely, and by whatever replays the retained log a year from
now. `decodeDomainEvent` used to say so plainly — it checked `event-name` against
the catalogue and trusted the payload, because a hand-written guess at a runtime
schema would have been a second source of truth free to drift from the first.

The registry is that missing source of truth, and it does not drift because a
test fails when it does. See _Keeping the two catalogues in step_ below.

## What is checked, and where

| Where                             | What it catches                                                     |
| --------------------------------- | ------------------------------------------------------------------- |
| `TransactionalOutbox.stage`       | A malformed payload, before the row exists                          |
| `encodeDomainEvent`               | A malformed payload, before bytes reach the topic                   |
| `decodeDomainEvent`               | A payload from any producer that does not match this build's schema |
| `catalogue.spec.ts`               | A schema change that breaks compatibility, before it merges         |
| `LocalSchemaRegistry` constructor | The same, at boot, for a build that got past CI somehow             |

The first is the one that saves the most trouble. TypeScript has already had its
say about a staged payload, but it says nothing about a field that is `undefined`
at runtime because a nullable column came back empty. Left to the relay, such an
event is durable garbage: a row that fails to publish, retries on its ladder, and
dead-letters minutes later in a background poller, nowhere near the code that
produced it. Validating at `stage` fails the caller's transaction instead, so the
operation and the event it would have announced roll back together and the stack
trace points at the bug.

On the consume side a violation is a **`schema-invalid`** dead letter, distinct
from `undecodable`. Both skip the retry ladder — neither becomes correct on a
second read — and they are reported separately because the owner differs. An
undecodable message is usually a foreign producer on our topic. A contract
violation is a producer of _this_ event emitting the wrong shape, and the header
says which version wrote it and which rejected it:

```
dlt-reason:     schema-invalid
dlt-error:      user.registered at domain-events/2@8817 violates its schema contract —
                written by v3, rejected by v2: /email must be string
```

`written by v3, rejected by v2` names a replica that is behind. `written by v2,
rejected by v2` means a producer is emitting something its own schema forbids —
which `stage` should have refused, and is the more interesting failure.

## Subjects

A subject is the **event name**, not the topic. This is Confluent's
RecordNameStrategy, and the default — TopicNameStrategy, `<topic>-value` — is
wrong here for a structural reason. `domain-event-codec.ts` deliberately puts
every event on one topic so that `user.registered` and `user.deleted` stay
ordered against each other, which means one topic carries several unrelated
payload shapes. Under TopicNameStrategy they would all be versions of one
subject, and every alternation between two event types would read as an
incompatible evolution of a single schema.

## The compatibility rule: FULL, transitively

The gate requires **FULL_TRANSITIVE** compatibility: every version of a subject
readable against every other version, in both directions.

- **Backward** — a new reader can read data written against an old schema. This
  is what a consumer-first rollout needs, and what the retained log needs, since
  a consumer starting from the beginning of a topic reads years of old writers'
  bytes.
- **Forward** — an old reader can read data written against a new schema. This is
  what a producer-first rollout needs.

A rolling deploy is neither, because during it both are true at once: old and new
consumers read one topic that old and new producers are both writing to, in an
order nobody controls. Hence FULL.

**Transitive** rather than pairwise, because a consumer validates against the
newest schema _it_ knows while the writer may be several versions back. Checking
only consecutive pairs permits a drift that walks: v1→v2 legal, v2→v3 legal, v1
against v3 broken. Every step passes review and the first symptom is a replay
dead-lettering the beginning of the topic.

### What that permits

Practically one thing: **adding an optional property**. That is not a poverty of
the checker, it is what FULL means — anything else changes what a reader on one
side of the deploy will accept.

| Change                                   | Backward | Forward |
| ---------------------------------------- | -------- | ------- |
| Add an optional property                 | ok       | ok      |
| Remove an optional property              | ok       | ok      |
| Add a required property                  | **no**   | ok      |
| Make an optional property required       | **no**   | ok      |
| Make a required property optional        | ok       | **no**  |
| Remove a required property               | ok       | **no**  |
| Widen a type (`string` → `string\|null`) | ok       | **no**  |
| Narrow a type                            | **no**   | ok      |
| Add an `enum` or a `format`              | **no**   | ok      |
| Remove an `enum` or a `format`           | ok       | **no**  |

When a change is genuinely needed and none of the above allows it, the answer is
a **new event name**, with the old one kept until its consumers are gone. That is
more honest than a compatible-looking edit: the two shapes really are different
events, and giving them different names is what lets a consumer opt into the new
one on its own schedule.

### The open content model

Every object node is `additionalProperties: true`, and the profile refuses
`false`. This is the rule the whole story rests on. With a closed content model,
adding a field breaks every consumer that has not been redeployed, because their
schema forbids the field they have not heard of — JSON Schema's version of the
problem, and the reason a registry's advice is always to leave the model open.

The cost is that a typo in a field name is not a validation error. It is an
unknown property, silently accepted, and reported as a missing one only if the
correct name was required.

## The profile

`json-schema.ts` defines a deliberately small subset of draft-07 — object, array,
scalar types, `required`, `enum`, `format`, `description` — and
`assertInProfile` **rejects anything else by name and path**: `$ref`, `oneOf`,
`if`/`then`, `patternProperties`, `pattern`, tuple-form `items`.

That refusal is the soundness argument for the whole gate. A checker that walked
a schema, understood `type` and `required`, and quietly ignored a `oneOf` would
report "compatible" for an evolution that broke every consumer, because the part
it did not read is the part that changed. Widening the profile is therefore a
deliberate change in two places at once — a case in `json-schema.ts` and a rule
in `compatibility.ts`.

Two conservative corners, both documented in the code:

- Two **different** formats are reported as breaking both directions. Nothing
  here can prove one format's values are a superset of the other's, and a checker
  that guesses is worse than one that says it cannot tell.
- Removing an **optional** property is treated as compatible, following the same
  convention a registry does under an open content model, even though the
  constraint on that field has technically vanished.

## Keeping the two catalogues in step

The compiler cannot check a JSON Schema document against a TypeScript interface,
so `catalogue/index.ts` closes the loop with a reference payload per event, typed
as that event's payload:

1. Add a field to `UserRegisteredPayload` → `REFERENCE_PAYLOADS` stops compiling
   until the field is supplied.
2. Supply it → `catalogue.spec.ts` fails until the schema declares it.
3. Declare it as **required** → the compatibility gate fails, because a new
   required property is not backward compatible.
4. Declare it as **optional** → green. Which is the correct answer, and the one a
   rushed change would not have found.

## Versions on the wire

`event-schema-version` carries the version the producer validated against. A
header rather than a prefix on `value`, which is where Confluent's clients put
the schema id (a magic byte and four bytes of id): the wire format here is plain
JSON on purpose — `kafka-console-consumer` prints it, `jq` reads it — and
prefixing the body with binary would end that for the sake of five bytes. The
cost is that a Confluent deserialiser cannot read this topic without being told
where to look.

The header is **not** used to choose a schema. A consumer always validates
against its own newest version, because that is the only question it needs
answered — whether _it_ can read these bytes — and FULL_TRANSITIVE is what makes
the answer reliably yes for any writer in the history. The header is for
diagnosis.

A **missing** header is tolerated and decoded as `writerSchemaVersion: null`. It
has to be: on the deploy that introduces this, every message already in the topic
was written by a producer that had no version to stamp, and rejecting those would
dead-letter the entire retained log on upgrade. A header that is present and
_not_ a version (`""`, `"v2"`, `"0"`) is rejected, because that is a producer
writing something this format does not define.

## Publishing to a remote registry

The shipped registry is local: the catalogue is TypeScript modules holding plain
JSON Schema documents, versioned by the same commit that changes the code they
describe. That is a starting point rather than a placeholder — the schema, the
producer and the consumer move together, the gate runs in the same CI job as the
tests, and a rollback takes the contract back with it, none of which is true of a
schema living in a server somebody updates out of band.

What a remote registry (Confluent, Apicurio) buys is a contract shared with
services that are not in this repository. `SchemaRegistry` in
`src/schema-registry/ports/` is the seam it binds to, and `catalogue.spec.ts`
asserts every document round-trips through `JSON.stringify` unchanged so the
catalogue can be published verbatim — subject `user.registered`, schema type
JSON, one POST per version in order.

Two things have to be decided before that is worth doing, and neither is decided
here: a fetch on the path of every message needs a cache with an eviction policy,
and a registry that is unreachable at boot has to either fail the deployment or
start from a stale cache — the same fail-closed question `IdempotencyStore`
answers with a 503.

## What this is still not

- **Not a remote registry.** One implementation, described above.
- **Not a validator of business rules.** No `format: "email"` on `email`, and no
  `enum` of providers on `provider`. The address has already been through
  `class-validator` at the API edge, and asserting a second, differently-spelled
  definition of a valid address on the wire only creates a way to reject data the
  system already accepted. Ajv's `email` regex and `IsEmail` do not agree.
- **Not applied to the in-process bus.** `DomainEventBus.publish` is unchecked.
  Its payloads never leave the process, so the type system is the whole contract;
  everything that crosses the boundary goes through the outbox or the codec, and
  both check.
- **Not a redrive tool.** A `schema-invalid` dead letter is preserved byte for
  byte with the headers to find its original, and putting it back once the
  producer is fixed is still manual, as `docs/messaging.md` says of the other
  reasons.
- **Not enforced on `dlt-` topics.** The dead-letter topic carries payloads that
  by definition failed validation, so nothing validates it.
