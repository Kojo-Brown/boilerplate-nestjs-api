# Messaging — Kafka producer and consumer

`src/messaging` puts a broker between the outbox relay and the subscribers that
react to domain events. Before it, an event was durable and retried but only
ever reached the replica whose relay claimed the row — the limitation
`docs/outbox.md` has carried since the outbox landed. Now it reaches every
consumer group over the topic, in this service and in any other.

Two variables turn it on:

```
OUTBOX_PUBLISHER=broker      # the relay produces instead of publishing in-process
MESSAGE_BROKER=kafka
KAFKA_BROKERS=kafka-1:9092,kafka-2:9092
```

Nothing else changes. `outbox-relay.service.ts` was not modified for this: it
claims rows, calls `publish`, and treats a rejection as "not delivered, try
again later", exactly as it did.

## The shape

```
AuthService.register
  └─ TransactionalOutbox.stage(tx, "user.registered", …)   ← same transaction as the user row
       └─ outbox_events row, committed with the data

OutboxRelayService (poll)
  └─ claims rows FOR UPDATE SKIP LOCKED
       └─ BrokerOutboxPublisher.publish
            └─ MessageBroker.produce      → topic "domain-events", key = userId, acks=all

DomainEventConsumer (group "boilerplate-nestjs-api")
  └─ MessageBroker.subscribe             ← autoCommit: false
       └─ DomainEventBus.publishAndSettle
            └─ @OnDomainEvent subscribers  ← unchanged; they do not know a broker exists
                 └─ commit offset+1        ← only once every subscriber has resolved
```

`MessageBroker` is a port with two implementations: `KafkaBroker` over KafkaJS,
and `InMemoryBroker`, an in-process broker that models partitions, consumer
groups, committed offsets and redelivery. Both satisfy
`message-broker.contract.ts`, which CI runs against the double on every leg and
against a real single-node cluster in the `test` job.

## The three decisions worth knowing

### The producer acknowledges durably or not at all

`idempotent: true`, which forces `acks: -1`: every in-sync replica has the
record before `send` resolves. `OutboxPublisher.publish` resolving is what marks
the row `PUBLISHED`, so a producer that resolved on enqueue would turn the
outbox back into at-most-once delivery — the exact failure it exists to remove.
Idempotence also gives the producer a per-partition sequence number, so its own
retry of a send that was in fact written does not append the record twice.

### Offsets are committed after the handler, never before

`autoCommit: false`. KafkaJS's default commits on a timer while messages are in
flight, which means a process that dies mid-handler has already told the broker
it was finished: the message is not redelivered and the work never happened.

The commit is therefore the last thing that happens for a message, and it
commits `offset + 1` — a committed offset in Kafka is _the next message to
read_, not the last one read. Committing `message.offset` replays that message
on every restart, forever. It lives in `nextOffset()`, with a test, rather than
inline at the call site, and it does the arithmetic in `BigInt` because offsets
are int64 and a busy partition exceeds `Number.MAX_SAFE_INTEGER`.

There is no `commit()` on the port. `handle` resolving _is_ the commit, so a
caller can neither commit early nor forget to commit. The cost is one round trip
to the group coordinator per message; committing every N messages is the usual
mitigation and widens the redelivery window to N, which is a decision to make
against a measured throughput rather than a default to ship.

The consequence is at-least-once delivery, unconditionally, and nothing can
configure that away — the alternative is committing first, which loses messages
instead. **Handlers must be idempotent.** `DomainEvent.id` is stable across
every redelivery of both halves of the pipeline, and it is what to deduplicate
on.

### One topic, keyed by the aggregate

Every domain event goes to `KAFKA_DOMAIN_EVENTS_TOPIC`, keyed by the user id.

Kafka orders within a partition, and a partition belongs to a topic. Splitting
the catalogue into `user-registered` and `user-deleted` topics would leave no
order at all between them, and a consumer could be told an account was deleted
before it heard it was created. On one topic with the same key both land on one
partition and arrive in the order they happened.

`PARTITION_KEY` in `domain-event-codec.ts` is a mapped type over
`DomainEventName`, so adding an event to the catalogue without deciding how it
is ordered is a compile error rather than a message that round-robins across
partitions.

The cost is selectivity: a consumer interested in one event type reads all of
them and filters on the `event-name` header. That stops being the right trade
when one event type dwarfs the others in volume, at which point it moves to its
own topic and gives up cross-type ordering knowingly.

## Consumer groups

`KAFKA_CONSUMER_GROUP_ID` names a _logical subscriber_, not a process.

- **Every replica of this service uses the same group id.** The group's members
  are assigned disjoint partitions, so each event is handled once no matter how
  many replicas are running. Deriving the id from a hostname or a pod name — an
  easy accident — turns a scaled deployment into fan-out and sends every welcome
  email once per replica.
- **A different service uses a different group id** and gets its own copy of the
  stream. That is the fan-out the in-process bus could never provide.

A group can usefully run at most one member per partition; members beyond that
idle, which is why `KAFKA_TOPIC_PARTITIONS` is the ceiling on consumer
parallelism. It can be raised later but never lowered, and raising it re-hashes
keys to different partitions — so `ensureTopics` creates a missing topic and
never alters an existing one, warning instead when the counts disagree.

## What a failure does

| Failure                            | What happens                                                                                                   |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Broker unreachable at boot         | `connect()` fails and the deployment fails with it, rather than 500ing on the first publish                    |
| Broker rejects a produce           | `publish` rejects, the relay leaves the row `PENDING` and retries by its own ladder                            |
| A subscriber throws                | Retried in place on the ladder; the whole event is re-run, successful subscribers included                     |
| The ladder runs out                | Copied to the dead-letter topic with its failure recorded in headers, then committed past                      |
| A message cannot be decoded        | Straight to the dead-letter topic — the ladder is skipped, because reading it again cannot help                |
| The process dies mid-handler       | The offset was never committed, so the next member of the group reads it again                                 |
| A handler never settles            | Bounded by `KAFKA_HANDLER_TIMEOUT_MS`, reported, not committed, and redelivered                                |
| The dead letter cannot be produced | No commit. The message is redelivered rather than committed with no copy of it anywhere                        |
| Shutdown lands mid-ladder          | The sleep is aborted, nothing is committed, and the next member of the group reads it again with a full budget |

The redelivery interval is `max(KAFKA_REDELIVERY_DELAY_MS, maxWaitTimeInMs)` —
about five seconds with KafkaJS's default fetch settings, because resuming a
partition does not produce a message, the next fetch does, and a fetch with
nothing new blocks at the broker until `maxWaitTimeInMs` elapses. Setting the
delay below a second buys nothing without also lowering `maxWaitTimeInMs`, which
costs a fetch request per partition per interval across the whole group whether
or not anything is failing.

### The handler bound, and why it exists

A handler that never settles used to be the worst failure in this pipeline, and
it was invisible. KafkaJS heartbeats _between_ messages, not during one, so a
consumer sitting inside `eachMessage` sends none — and after
`KAFKA_SESSION_TIMEOUT_MS` the coordinator evicts the member, the group goes
empty, and the service stops consuming with nothing in its log and a healthy
`/health`. That is not hypothetical: it is what this application did the first
time it was run against a real cluster with Redis down, because
`WelcomeEmailListener` enqueues through BullMQ and ioredis retries a refused
connection indefinitely.

Two things fix it, and they have to travel together. A heartbeat runs on a timer
while the handler is in flight, so _slow_ work no longer triggers a rebalance;
and `KAFKA_HANDLER_TIMEOUT_MS` bounds the handler, so _stuck_ work becomes an
ordinary failure — logged, uncommitted, redelivered. Heartbeating without the
bound would keep a permanently hung handler in the group forever, holding its
partitions and reading nothing: the same outage with a better disguise.

The bound does not _cancel_ the handler — racing a promise you did not create
cannot — which is the same limit `OutboxRelayService` documents for its publish
timeout, and one more reason handlers have to be idempotent. Both
implementations enforce it and the contract asserts it, because it is a property
of the port rather than of a client library.

The undecodable case is the one failure that is _not_ retried, and it is
deliberate rather than an oversight: bytes that are not a domain event this
build recognises will not become one by being read again, so retrying blocks the
partition forever over a message no version of this code can handle — and takes
every well-formed event behind it down with it. It goes straight to the
dead-letter topic instead, on its first and only attempt.

## The retry ladder and the dead-letter topic

Before these existed, a consumer's only two moves on a failure were to keep
retrying — blocking the partition, and every well-formed event behind the bad
one — or to commit past and lose the message. It took the first for handler
failures and the second for undecodable ones, and neither is a decision anybody
would make deliberately.

A message now gets `KAFKA_RETRY_MAX_ATTEMPTS` attempts, spaced by full-jitter
exponential backoff, and then goes to `<KAFKA_DOMAIN_EVENTS_TOPIC>.dlt` and is
committed past. The partition continues; the message still exists.

### The count lives in this process, because Kafka has nowhere to put it

A Kafka record carries no delivery count. A consumer that declines to commit gets
the message again, and again, with nothing anywhere recording how many times —
which is why redelivery alone cannot become "try four times, then give up". The
count has to be held by whoever is counting, and the only place that can be is
the process handling the message.

What that costs: the count does not survive a crash. A message that has burned
three of four attempts when the pod dies comes back to its replacement with a
fresh four, so the real bound is attempts-per-delivery rather than
attempts-per-message. The alternative is a row keyed by partition and offset,
written on the path of every failure, so that a poison message reaches the
dead-letter topic slightly sooner after an unrelated restart. That is not worth a
database write per failure.

### Retrying in place blocks the partition, and that is the trade being made

The usual alternative is a chain of retry topics: a failed message is
republished to `…retry-1s`, `…retry-30s` and so on, so the main partition can
move on immediately. It is the wrong trade _here_, and the reason is the decision
under **One topic, keyed by the aggregate** above. This stream is ordered per
user. A `user.registered` diverted onto a retry topic while the `user.deleted`
behind it sails through the main one arrives after the deletion it preceded, and
a subscriber is told an account was removed before it hears it existed.

Ordering within an aggregate is worth more than head-of-line latency on a
partition that is failing anyway — and the head-of-line cost is now _bounded_,
which is the actual change. Before the ladder it was unbounded, because there was
no way to give up.

### The ladder has to fit inside the handler bound

The ladder runs inside one `handle()` call, and `handle()` is bounded by
`KAFKA_HANDLER_TIMEOUT_MS`. A ladder whose sleeps alone outlast that bound can
never reach its last attempt: the handler is cut off mid-ladder, the message is
redelivered by the broker with a fresh budget, and it never reaches the
dead-letter topic. The result is a poison message blocking its partition forever
under a configuration that reads as though it had been given four tries and a way
out — which is worse than not having configured a ladder at all.

`env.schema.ts` refuses that combination at boot, using `worstCaseLadderMs` (the
sum of the un-jittered ceilings) against the handler bound with room left for the
attempts themselves. It is the necessary condition, not the sufficient one: how
long an attempt takes is up to the handler.

### What lands on the dead-letter topic

The original message, byte for byte, under its original key — so the dead-letter
topic partitions by aggregate exactly as the source topic does, and (both topics
being created with the same partition count) a record lands on the same partition
number on both. Reading partition 2 of the dead-letter topic is reading the
failures from partition 2 of the source.

The producer's headers are preserved, and these are added:

| Header                 | What it is                                                      |
| ---------------------- | --------------------------------------------------------------- |
| `dlt-reason`           | `undecodable` or `handler-failed` — a different fix each        |
| `dlt-error`            | The last error's message, truncated to 500 characters           |
| `dlt-error-type`       | Its constructor name, which is stable enough to route on        |
| `dlt-attempts`         | How many were made. `1` for a message that was never retryable  |
| `dlt-consumer-group`   | Which group gave up; two groups can dead-letter the same record |
| `dlt-origin-topic`     | Where the original is                                           |
| `dlt-origin-partition` | …                                                               |
| `dlt-origin-offset`    | …as a string, since offsets pass `Number.MAX_SAFE_INTEGER`      |
| `dlt-failed-at`        | When this process gave up                                       |

The origin coordinates are what `kafka-console-consumer --partition --offset`
takes, so the original record can be read back off the source topic and compared
against the copy.

`dlt-error` is truncated because Kafka counts headers against
`message.max.bytes`: an unbounded stack trace, or a driver error quoting a whole
statement, could make the record that _reports_ a failure fail to produce — which
would lose the message the topic exists to keep.

### Nothing consumes it

Deliberately. A dead-letter topic that is drained back into the main topic
automatically is a retry loop with extra steps, and the failure it produces —
events cycling between two topics forever — is harder to see than the poison
message it was meant to solve. Redriving is a human decision made once the cause
is fixed, which is what the origin headers are for.

Two operational pieces this repository cannot provide: a retention on the
dead-letter topic long enough that a message is still there when somebody looks,
and an alert on its rate. A dead-letter topic nobody is watching is a slower way
of dropping messages.

### Failing to dead-letter does not commit

If the produce to the dead-letter topic fails, `DeadLetterQueue.send` throws and
the offset is not committed — so the message is redelivered and the whole ladder
runs again. Wasteful, and the right kind of wasteful: the alternative is
committing past a message the consumer has given up on and failed to copy
anywhere, which is silent loss on exactly the path that exists to prevent it.

The same rule covers `KAFKA_DEAD_LETTER_ENABLED=false`: an exhausted ladder
rethrows and the partition stalls, loudly, rather than dropping anything. That is
the pre-item behaviour, kept as a switch because a stream where a gap is worse
than a stop is a real thing to have — but it is not the default, because an
unattended service that has silently stopped consuming is the failure the topic
exists to end.

### Shutdown does not dead-letter in-flight work

`stop()` aborts the ladder before waiting for the subscription, so a consumer
sleeping between attempts unwinds in milliseconds rather than being waited out
per partition. The message is left uncommitted and whichever member takes the
partition next reads it again with a full budget.

Dead-lettering on abort instead would mean a rolling restart during a downstream
outage quietly moved every in-flight event onto the dead-letter topic — turning a
recoverable failure into a pile of manual redrives. An aborted ladder has proven
nothing about the message; only an exhausted one has.

## Configuration

| Variable                      | Default                  | Notes                                                |
| ----------------------------- | ------------------------ | ---------------------------------------------------- |
| `OUTBOX_PUBLISHER`            | `bus`                    | `broker` sends relayed events to Kafka               |
| `MESSAGE_BROKER`              | `memory`                 | `kafka` for a real cluster                           |
| `KAFKA_BROKERS`               | —                        | Required when `MESSAGE_BROKER=kafka`                 |
| `KAFKA_CLIENT_ID`             | `boilerplate-nestjs-api` | Shows in broker logs and quota config                |
| `KAFKA_DOMAIN_EVENTS_TOPIC`   | `domain-events`          |                                                      |
| `KAFKA_TOPIC_PARTITIONS`      | `3`                      | Ceiling on consumer parallelism                      |
| `KAFKA_ENSURE_TOPICS`         | `true`                   | `false` where topics are managed externally          |
| `KAFKA_CONSUMER_ENABLED`      | `true`                   | `false` for a produce-only replica                   |
| `KAFKA_CONSUMER_GROUP_ID`     | `boilerplate-nestjs-api` | One value for the whole deployment                   |
| `KAFKA_SESSION_TIMEOUT_MS`    | `30000`                  | Between the broker's min and max (6s–30min)          |
| `KAFKA_HEARTBEAT_INTERVAL_MS` | `3000`                   | At most a third of the session timeout               |
| `KAFKA_REDELIVERY_DELAY_MS`   | `1000`                   | Floor, not the interval — see above                  |
| `KAFKA_HANDLER_TIMEOUT_MS`    | `60000`                  | A hung handler becomes a redelivery, not an eviction |
| `KAFKA_DEAD_LETTER_ENABLED`   | `true`                   | `false` stalls the partition instead of giving up    |
| `KAFKA_DEAD_LETTER_TOPIC`     | `<events topic>.dlt`     | Derived, so renaming the events topic moves it       |
| `KAFKA_RETRY_MAX_ATTEMPTS`    | `4`                      | The first attempt included; `1` disables retrying    |
| `KAFKA_RETRY_BASE_MS`         | `250`                    | Before jitter                                        |
| `KAFKA_RETRY_MAX_DELAY_MS`    | `5000`                   | Ceiling per rung, before jitter                      |
| `KAFKA_SSL` / `KAFKA_SASL_*`  | off                      | `plain` is refused without TLS; SCRAM is not         |

`MESSAGE_BROKER=memory` is refused in production when `OUTBOX_PUBLISHER=broker`,
for the reason `IDEMPOTENCY_STORE=memory` is: nothing errors, every publish
succeeds, and no other replica hears any of it. With `OUTBOX_PUBLISHER=bus` it is
simply an unused broker and is allowed.

## Testing

| Suite                                   | What it can prove                                                              |
| --------------------------------------- | ------------------------------------------------------------------------------ |
| `message-broker.contract.ts`            | The behaviour both implementations must share                                  |
| `…contract.spec.ts` (memory leg)        | …against the double the unit and e2e suites run on                             |
| `…contract.spec.ts` (Kafka leg)         | …against a real cluster: real groups, real commits, real rebalances            |
| `domain-event-codec.spec.ts`            | The wire format, the partition keys, and every way a message can be unreadable |
| `domain-event-consumer.service.spec.ts` | The ladder, both routes to the dead-letter topic, and what shutdown does       |
| `retry-ladder.spec.ts`                  | The ladder in isolation: its budget, its sleeps, and its abort                 |
| `dead-letter.spec.ts`                   | What a dead letter preserves and what it records                               |
| `dead-letter-queue.service.spec.ts`     | That a failed dead letter is reported rather than swallowed                    |
| `test/messaging.e2e-spec.ts`            | That the stages are connected, through the real wiring                         |

The split matters. Three of the properties the contract asserts are properties
of _Kafka_ rather than of the code in front of it — that a committed offset is
the next one to read, that a group's members get disjoint partitions, and that a
rejoining member resumes from what was committed. Asserted only against the
double they would be properties of a `Map`; asserted only against a cluster,
nothing would stop the double the rest of the suite runs on from breaking all
three. The Kafka leg reports _pending_ rather than skipping green when
`KAFKA_BROKERS` is unset, so an environment without a cluster cannot quietly
turn it off.

## What this is not

- **Not a redrive tool.** Producing a dead letter back to its origin topic is
  three lines against `MessageBroker` and a decision nobody should make from a
  script that runs unattended, so the headers carry what a redrive needs and the
  redrive itself is left to whoever is fixing the cause.
- **Not alerted.** Nothing here watches the dead-letter topic's rate or its
  retention, and both are what turn it from a place messages are kept into a
  slower way of dropping them.
- **Not a per-subscriber ladder.** A retry re-runs the whole event, so a
  subscriber that succeeded runs again while the one next to it is retried. The
  outbox relay makes the same trade with the same bus (`docs/outbox.md`, _Not
  per-handler retry_), and it is why `@OnDomainEvent` handlers have to be
  idempotent.
- ~~**Not schema-validated.**~~ Closed. `event-name` is checked against the
  catalogue and the payload against the JSON Schema registered for it, on the way
  in and on the way out. A payload that does not conform is a `schema-invalid`
  dead letter, ladder skipped, with the writer's and the reader's schema versions
  in `dlt-error`. See `docs/schema-registry.md`.
- **Not exactly-once.** Both halves of the pipeline deliver at least once and
  neither can be configured out of it. Kafka's transactional producer plus
  `read_committed` would give exactly-once _within_ Kafka; it would not make a
  handler's side effects exactly-once, which is what an idempotent handler is
  for.
- **Not ordered across a retry.** A message that fails and is redelivered is
  handled after messages its partition received in the meantime have been
  handled by other members — and a partition whose count is raised re-hashes
  keys, so ordering holds for keys that stay put and not for those that move.
- **Not a schema for the topic name.** `ensureTopics` will create
  `KAFKA_DOMAIN_EVENTS_TOPIC` with `KAFKA_TOPIC_PARTITIONS` partitions on the
  first boot that finds it missing. In a deployment where topics are managed
  externally, set `KAFKA_ENSURE_TOPICS=false` so a typo is an error rather than
  a new empty topic.
