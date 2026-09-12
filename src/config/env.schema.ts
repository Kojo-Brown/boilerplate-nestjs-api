import { z } from "zod";
import { worstCaseLadderMs } from "@/common/backoff";
import { IDEMPOTENCY_STORE_NAMES } from "@/common/idempotency/ports";
import { DISTRIBUTED_LOCK_NAMES } from "@/common/locking/ports";
import { MESSAGE_BROKER_NAMES } from "@/messaging/ports";
import { OUTBOX_PUBLISHER_NAMES } from "@/outbox/ports";
import { PAYMENT_PROVIDER_NAMES } from "@/payments/ports";
import { STORAGE_ADAPTER_NAMES } from "@/storage/ports";
import { refineTelemetryEnv, telemetryEnvShape } from "@/telemetry/telemetry.env";
import { WORKER_POOL_NAMES } from "@/workers/ports";

export const envSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    PORT: z.coerce.number().default(4000),
    DATABASE_URL: z.string().url(),
    JWT_SECRET: z.string().min(32),
    JWT_ACCESS_EXPIRY: z.string().default("15m"),
    JWT_REFRESH_EXPIRY: z.string().default("7d"),
    GOOGLE_CLIENT_ID: z.string().optional(),
    GOOGLE_CLIENT_SECRET: z.string().optional(),
    GOOGLE_CALLBACK_URL: z.string().optional(),
    ALLOWED_ORIGINS: z.string().default("*"),
    REDIS_URL: z.string().optional(),

    /**
     * Which backend `StorageService` stores files through.
     *
     * Defaults to `memory` so a clean clone boots with no storage
     * configuration at all — the same reason `PAYMENTS_PROVIDER` defaults to
     * `mock`. That default is refused outright in production below, because a
     * memory-backed store does not fail loudly: it accepts every upload and
     * loses them all on the next deploy.
     */
    STORAGE_ADAPTER: z.enum(STORAGE_ADAPTER_NAMES).default("memory"),
    /** Root directory for `STORAGE_ADAPTER=local`. Created on first write. */
    STORAGE_LOCAL_ROOT: z.string().default("./storage"),

    /**
     * Where `Idempotency-Key` records are kept.
     *
     * Defaults to `memory` for the same reason `STORAGE_ADAPTER` does — a clean
     * clone boots with nothing configured — and is refused in production for a
     * sharper version of the same reason: two replicas do not share a `Map`, so
     * the retry that lands on the other one executes the operation twice, which
     * is exactly what the header was sent to prevent.
     */
    IDEMPOTENCY_STORE: z.enum(IDEMPOTENCY_STORE_NAMES).default("memory"),
    /**
     * How long a key stays claimed. 24 hours matches Stripe's window and is
     * comfortably longer than any client's retry ladder; the record is what
     * makes a retry safe, so it has to outlive the retrying.
     */
    IDEMPOTENCY_TTL_SECONDS: z.coerce.number().int().positive().default(86_400),

    /**
     * What backs `@Lock()` and `withLock()`.
     *
     * Defaults to `memory` for the same reason `IDEMPOTENCY_STORE` does — a
     * clean clone boots with nothing configured — and is refused in production
     * for the same reason too, only sooner: a `Map` is not shared between
     * replicas, so the second replica takes every lock the first one is
     * already holding.
     */
    DISTRIBUTED_LOCK: z.enum(DISTRIBUTED_LOCK_NAMES).default("memory"),
    /**
     * Comma-separated URLs of the **independent** Redis masters Redlock votes
     * over — `redis://a:6379,redis://b:6379,redis://c:6379`.
     *
     * Independent is the requirement, not a suggestion: nodes that replicate to
     * each other do not make a quorum, they make one node with copies. A lock
     * acknowledged by a primary and not yet replicated simply is not there
     * after a failover, and the next caller takes a lock somebody holds.
     *
     * Falls back to `REDIS_URL` when unset, which is a one-node configuration
     * and logs a warning saying so.
     */
    REDLOCK_NODES: z.string().optional(),

    /**
     * Which `WorkerPool` runs CPU-bound tasks.
     *
     * `piscina` is the real one — a fixed thread pool with a bounded queue,
     * built for exactly this. `inline` runs each task on the caller's thread
     * inside a resolved promise and preserves the pool's observable contract
     * (queue depth, `stats()`, `shutdown()`) without offloading any work; it
     * is the right choice for tests and a knowingly-degraded choice for a
     * small deployment where blocking the event loop for a few dozen
     * milliseconds is not a concern. See `docs/worker-pool.md`.
     */
    WORKER_POOL: z.enum(WORKER_POOL_NAMES).default("inline"),
    /**
     * Hard cap on concurrent workers. Piscina's own default is
     * `availableParallelism() - 1`, which is invisible to a container's
     * cgroup CPU quota — an operator has to name a number they mean.
     *
     * A `piscina` pool with `maxThreads=0` starts no workers at all, so the
     * schema refuses it: choose `WORKER_POOL=inline` for that instead of
     * pretending the pool is running.
     */
    WORKER_POOL_MAX_THREADS: z.coerce.number().int().positive().default(2),
    /**
     * Hard cap on queued (not yet running) tasks. Piscina's default is
     * `Infinity`, which turns the pool into a memory leak the moment
     * producers outrun workers; the pool rejects overflow with
     * `WorkerPoolSaturatedError` before calling into Piscina at all, which
     * is what an HTTP caller wants — a fast 503 rather than latency behind
     * a backlog that will not clear.
     */
    WORKER_POOL_MAX_QUEUE: z.coerce.number().int().nonnegative().default(32),
    /**
     * Default wait a `run()` will tolerate before rejecting with
     * `WorkerPoolTimeoutError`. Overridable per call. The wait ends;
     * the worker keeps burning until the task returns, which is the one
     * thing Piscina cannot help with without discarding the thread.
     */
    WORKER_POOL_TASK_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),

    /**
     * Whether this process runs the outbox relay.
     *
     * On by default, because an outbox nobody drains is a queue that only grows
     * and a set of events nobody receives. Turning it off is for the two
     * deployments where that is the right answer: a test that drives
     * `runOnce()` itself and wants no timer, and a topology that relays from a
     * dedicated worker rather than from every API replica.
     *
     * Running it on several replicas at once is supported and is the default
     * shape — the claim is `FOR UPDATE SKIP LOCKED`, so replicas take disjoint
     * batches rather than duplicating or blocking each other.
     *
     * Not `z.coerce.boolean()`: that is `Boolean(value)`, under which every
     * non-empty string is true — so `OUTBOX_RELAY_ENABLED=false` would *enable*
     * the relay, and the one setting whose whole purpose is to turn something
     * off would be impossible to use. The union below accepts the spellings an
     * operator actually types and rejects anything else with an error naming
     * the variable, rather than guessing.
     */
    OUTBOX_RELAY_ENABLED: z
      .union([z.boolean(), z.enum(["true", "false", "1", "0"])])
      .default(true)
      .transform((value) => value === true || value === "true" || value === "1"),
    /**
     * How long an event may sit staged before the relay looks at it.
     *
     * This is added latency on every event, and lowering it is not free: each
     * tick is a query per replica whether or not anything is due. A second is a
     * deliberate middle — the events in the catalogue are welcome emails and
     * cleanup, none of which a user is watching a spinner for.
     */
    OUTBOX_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(1_000),
    /**
     * Rows claimed per pass. The batch is held under row locks for the whole
     * pass, so this is really "how many events one relay may make invisible to
     * the others at once" — large enough to drain a backlog, small enough that
     * a slow broker does not park a hundred events behind one bad publish.
     */
    OUTBOX_BATCH_SIZE: z.coerce.number().int().positive().default(50),
    /**
     * How long one publish may take before it is treated as failed. It bounds
     * the drain transaction: without it a broker that stops answering holds the
     * claim, and every row in the batch with it, until the transaction times
     * out much later.
     */
    OUTBOX_PUBLISH_TIMEOUT_MS: z.coerce.number().int().positive().default(5_000),
    /** First retry delay, before jitter. The ladder doubles from here. */
    OUTBOX_BACKOFF_BASE_MS: z.coerce.number().int().positive().default(500),
    /** Ceiling on the retry delay, so the ladder plateaus rather than running away. */
    OUTBOX_BACKOFF_MAX_MS: z.coerce.number().int().positive().default(300_000),
    /**
     * Attempts before an event is dead-lettered. Eight with the defaults above
     * is a little over twenty minutes of retrying — long enough to ride out a
     * broker restart, short enough that a genuinely poisonous event is in front
     * of a human the same morning.
     */
    OUTBOX_MAX_ATTEMPTS: z.coerce.number().int().positive().default(8),

    /**
     * Where the relay delivers a claimed event.
     *
     * `bus` hands it to this process's `DomainEventBus`, which is durable and
     * retried but reaches no other replica — the limitation `docs/outbox.md`
     * has carried since the outbox landed. `broker` produces it to
     * `KAFKA_DOMAIN_EVENTS_TOPIC`, from which every consumer group over that
     * topic gets a copy, in this service and in any other.
     *
     * Still `bus` by default, and deliberately: a clean clone boots with no
     * broker configured, exactly as it boots with no S3 bucket and no Redis.
     * Switching it is one variable and no code, because the relay talks to a
     * port.
     */
    OUTBOX_PUBLISHER: z.enum(OUTBOX_PUBLISHER_NAMES).default("bus"),

    /**
     * Which `MessageBroker` backs the producer and the consumer.
     *
     * `memory` is a working in-process broker — partitions, consumer groups,
     * committed offsets and all — which makes it the right backend for tests
     * and for a development run with nothing installed. It is refused below in
     * production the moment anything real depends on it, for the sharpest
     * version of the reason `STORAGE_ADAPTER=memory` and
     * `IDEMPOTENCY_STORE=memory` are: a broker inside the process reaches no
     * other process, which is the entire reason to have a broker.
     */
    MESSAGE_BROKER: z.enum(MESSAGE_BROKER_NAMES).default("memory"),
    /** Comma-separated `host:port` bootstrap brokers — `kafka-1:9092,kafka-2:9092`. */
    KAFKA_BROKERS: z.string().optional(),
    /**
     * Identifies this application to the cluster. It shows up in broker logs,
     * in quota configuration and in `kafka-consumer-groups --describe`, so it
     * is worth being the service name rather than a default nobody can trace.
     */
    KAFKA_CLIENT_ID: z.string().default("boilerplate-nestjs-api"),
    /**
     * The one topic every domain event travels on. One rather than one per
     * event name, because Kafka orders within a partition and a partition
     * belongs to a topic — see `docs/messaging.md`.
     */
    KAFKA_DOMAIN_EVENTS_TOPIC: z.string().default("domain-events"),
    /**
     * Partitions for that topic when this service creates it.
     *
     * The ceiling on consumer parallelism: a group can usefully run one member
     * per partition and any beyond that idle. Three is a starting point for a
     * service with a handful of replicas; raising it later is possible, lowering
     * it is not, and raising it re-hashes keys to different partitions — which
     * breaks per-key ordering for every key that moves.
     */
    KAFKA_TOPIC_PARTITIONS: z.coerce.number().int().positive().default(3),
    /**
     * Whether this service creates the topic at boot if it is missing.
     *
     * True by default so a development cluster needs no setup. Production
     * deployments usually manage topics with their own tooling and give the
     * application no create permission at all, in which case this is `false`
     * and a missing topic is an error rather than a topic with the wrong
     * partition count created by whichever replica booted first.
     */
    KAFKA_ENSURE_TOPICS: z
      .union([z.boolean(), z.enum(["true", "false", "1", "0"])])
      .default(true)
      .transform((value) => value === true || value === "true" || value === "1"),

    /**
     * Whether this process reads the domain-event topic.
     *
     * Off for a replica that only produces, and for a test that drives the
     * consumer itself. Not `z.coerce.boolean()`, for the reason spelled out
     * against `OUTBOX_RELAY_ENABLED`: under it, `=false` would mean true.
     */
    KAFKA_CONSUMER_ENABLED: z
      .union([z.boolean(), z.enum(["true", "false", "1", "0"])])
      .default(true)
      .transform((value) => value === true || value === "true" || value === "1"),
    /**
     * The consumer group every replica of *this* service joins.
     *
     * One value for the whole deployment, which is what makes the replicas
     * split the partitions and handle each event once. Deriving it from a
     * hostname or a pod id is the mistake that turns a scaled deployment into
     * fan-out and sends every welcome email once per replica.
     */
    KAFKA_CONSUMER_GROUP_ID: z.string().default("boilerplate-nestjs-api"),
    /**
     * How long the coordinator waits for a heartbeat before evicting a member
     * and moving its partitions. Must sit between the broker's
     * `group.min.session.timeout.ms` and `group.max.session.timeout.ms`
     * (6s–30min by default).
     */
    KAFKA_SESSION_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
    /**
     * Kafka's own guidance is no more than a third of the session timeout, so a
     * member survives losing two heartbeats to a network blip.
     */
    KAFKA_HEARTBEAT_INTERVAL_MS: z.coerce.number().int().positive().default(3_000),
    /**
     * How long a partition is paused after a handler rejected a message, before
     * that message is read again. Without a pause the partition is re-fetched
     * immediately and a handler failing on something slow to recover becomes a
     * hot loop against it.
     */
    KAFKA_REDELIVERY_DELAY_MS: z.coerce.number().int().positive().default(1_000),
    /** How long `subscribe` waits to join the group before failing the boot. */
    KAFKA_SUBSCRIBE_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
    /**
     * How long one subscriber may take before the message is treated as failed
     * and redelivered.
     *
     * The bound exists because a handler that never settles is worse than one
     * that throws: the consumer sits inside `eachMessage`, stops heartbeating,
     * and is evicted from its group after `KAFKA_SESSION_TIMEOUT_MS` — so the
     * service stops consuming while `/health` stays green and nothing is logged.
     * This was not theoretical; it is what the application did the first time it
     * was run against a real cluster with Redis down.
     *
     * A minute is generously above any handler in the catalogue and far below
     * the point at which a hang is worth waiting out.
     */
    KAFKA_HANDLER_TIMEOUT_MS: z.coerce.number().int().positive().default(60_000),
    /**
     * Whether a message the consumer has given up on is copied to the
     * dead-letter topic and committed past.
     *
     * `false` is the behaviour from before there was one: an exhausted ladder
     * withholds the commit and the message is redelivered indefinitely, blocking
     * its partition. That is a defensible choice for a stream where a gap is
     * worse than a stall, and it is the reason this is a switch rather than
     * something hardcoded on — but it is not the default, because an unattended
     * service that stops consuming is the failure the topic exists to end.
     *
     * Spelled against the enum rather than `z.coerce.boolean()` for the reason
     * `OUTBOX_RELAY_ENABLED` is: coercion makes every non-empty string true, so
     * `KAFKA_DEAD_LETTER_ENABLED=false` would *enable* it.
     */
    KAFKA_DEAD_LETTER_ENABLED: z
      .enum(["true", "false"])
      .default("true")
      .transform((value) => value === "true"),
    /**
     * The dead-letter topic. Defaults to `<KAFKA_DOMAIN_EVENTS_TOPIC>.dlt`.
     *
     * Optional rather than a literal default, because a literal would keep
     * saying `domain-events.dlt` after somebody renamed the events topic, and
     * the resulting dead letters would go somewhere nothing is watching. The
     * derivation lives in `defaultDeadLetterTopic` next to the code that would
     * otherwise have to guess.
     */
    KAFKA_DEAD_LETTER_TOPIC: z
      .string()
      .optional()
      // Blank means unset, not a topic named "". `.env` files spell "I have not
      // chosen a value" as `KEY=`, and dotenv hands that through as an empty
      // string — so a bare `.min(1)` here would make a `.env` copied from
      // `.env.example` fail to boot, on a variable the operator never touched.
      .transform((value) => {
        const trimmed = value?.trim() ?? "";
        return trimmed === "" ? undefined : trimmed;
      }),
    /**
     * Attempts one message gets before it is dead-lettered, the first included.
     *
     * Four rather than a larger number because the ladder blocks its partition
     * while it runs, and because what it is waiting out is a dependency
     * flapping, not a dependency down: an outage longer than a couple of seconds
     * is better served by the message going to the dead-letter topic and the
     * partition continuing than by every consumer in the group holding its
     * partitions until the outage ends. `1` disables retrying without disabling
     * the dead-letter topic.
     */
    KAFKA_RETRY_MAX_ATTEMPTS: z.coerce.number().int().positive().default(4),
    /** Delay before the second attempt, before jitter. */
    KAFKA_RETRY_BASE_MS: z.coerce.number().int().positive().default(250),
    /** Ceiling on the un-jittered delay, so the ladder plateaus instead of running away. */
    KAFKA_RETRY_MAX_DELAY_MS: z.coerce.number().int().positive().default(5_000),
    KAFKA_CONNECTION_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
    KAFKA_REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),

    /** TLS to the brokers. Off by default because a local cluster has none. */
    KAFKA_SSL: z
      .union([z.boolean(), z.enum(["true", "false", "1", "0"])])
      .default(false)
      .transform((value) => value === true || value === "true" || value === "1"),
    /**
     * SASL mechanism, if the cluster authenticates. Unset means no SASL at all,
     * which is the only honest default: a mechanism with no credentials fails
     * the handshake rather than connecting anonymously.
     *
     * `plain` sends the password in the clear and is only safe under TLS, which
     * the refinement below enforces. The OAuth and AWS IAM mechanisms KafkaJS
     * also supports need a callback rather than a password and are not wired
     * here — a deployment using one constructs `KafkaBroker` itself.
     */
    KAFKA_SASL_MECHANISM: z.enum(["plain", "scram-sha-256", "scram-sha-512"]).optional(),
    KAFKA_SASL_USERNAME: z.string().optional(),
    KAFKA_SASL_PASSWORD: z.string().optional(),

    S3_ENDPOINT: z.string().url().optional(),
    S3_REGION: z.string().default("us-east-1"),
    S3_BUCKET: z.string().optional(),
    S3_ACCESS_KEY_ID: z.string().optional(),
    S3_SECRET_ACCESS_KEY: z.string().optional(),

    /** Which gateway `PaymentProviderFactory` hands out when none is named. */
    PAYMENTS_PROVIDER: z.enum(PAYMENT_PROVIDER_NAMES).default("mock"),
    STRIPE_SECRET_KEY: z.string().optional(),
    STRIPE_API_BASE_URL: z.string().url().default("https://api.stripe.com"),
    /**
     * Optional. Unset means Stripe uses the version pinned to the account,
     * which is the one its dashboard and webhooks already agree on; a dated
     * string Stripe does not recognise is a 400 on every request, so there is
     * no safe default to ship.
     */
    STRIPE_API_VERSION: z.string().optional(),
    PAYPAL_CLIENT_ID: z.string().optional(),
    PAYPAL_CLIENT_SECRET: z.string().optional(),
    PAYPAL_API_BASE_URL: z.string().url().default("https://api-m.sandbox.paypal.com"),

    /**
     * Notification channels. All optional: a channel without credentials
     * reports `isConfigured === false` and `NotificationDispatcher` skips it,
     * so a deployment with no Twilio account still sends email and push. Unlike
     * `PAYMENTS_PROVIDER` there is nothing to select here — the user's
     * preferences choose the channel, not the environment.
     */
    TWILIO_ACCOUNT_SID: z.string().optional(),
    TWILIO_AUTH_TOKEN: z.string().optional(),
    /** E.164 sending number. Either this or a messaging service SID enables SMS. */
    TWILIO_FROM_NUMBER: z.string().optional(),
    /** `MG…`. Preferred over a bare number: Twilio then owns number pooling and opt-outs. */
    TWILIO_MESSAGING_SERVICE_SID: z.string().optional(),
    TWILIO_API_BASE_URL: z.string().url().default("https://api.twilio.com"),

    /**
     * Expo's push endpoint accepts unauthenticated requests, which would let
     * anyone holding a device token push to that device. Supplying a token
     * opts into Expo's enhanced security; the push channel treats it as
     * required rather than optional for exactly that reason.
     */
    EXPO_ACCESS_TOKEN: z.string().optional(),
    EXPO_PUSH_API_BASE_URL: z.string().url().default("https://exp.host"),

    /**
     * How often an idle Server-Sent Events connection is sent a keep-alive.
     *
     * An idle SSE stream looks identical to a dead one from every intermediary
     * between the client and this process, and they close it: 60s is nginx's
     * `proxy_read_timeout` default, 60s is an AWS ALB's idle timeout, 30s is a
     * common CDN. The default here is a quarter of the tightest of those, so a
     * connection survives losing two keep-alives to a blip — the same
     * reasoning, and the same ratio, as `KAFKA_HEARTBEAT_INTERVAL_MS` against
     * the session timeout.
     */
    SSE_HEARTBEAT_INTERVAL_MS: z.coerce.number().int().positive().default(15_000),
    /**
     * How many recent events are retained for a reconnecting client to be
     * caught up from.
     *
     * Counted in events, not seconds, which is what makes it a bound: memory is
     * `size × the largest payload` regardless of what the event rate does. The
     * cost of that choice is that the window a client can miss and still resume
     * *shrinks* as traffic rises, which is the opposite of what an operator
     * expects — see `docs/streaming.md`, where the arithmetic for choosing this
     * against a peak rate is written out.
     */
    SSE_REPLAY_BUFFER_SIZE: z.coerce.number().int().positive().default(1_024),
    /**
     * The most simultaneous streams this process will hold open.
     *
     * SSE connections are held, not served and released, so nothing else in the
     * request path bounds them: without this the limit is the file-descriptor
     * table, and the failure is the process refusing every connection of every
     * kind rather than this endpoint refusing new subscribers. Over the limit
     * is a 503, which is what a load balancer needs to shed to another replica.
     */
    SSE_MAX_CONNECTIONS: z.coerce.number().int().positive().default(1_000),
    /**
     * The `retry:` hint sent to clients, in milliseconds.
     *
     * `EventSource` defaults to about 3s and does not back off, so a deploy
     * that drops N connections brings all N back 3 seconds later, together,
     * against a process that is still warming up. Raising this is the only
     * control the server has over that; a client that reconnects on its own
     * terms should add jitter of its own.
     */
    SSE_RETRY_HINT_MS: z.coerce.number().int().positive().default(3_000),

    /**
     * The most simultaneous WebSocket connections this process will hold.
     *
     * Counted separately from `SSE_MAX_CONNECTIONS` rather than shared with it,
     * because the two cost different things: an SSE stream is a response and a
     * timer, a WebSocket is a response, a timer and a send buffer bounded by
     * `WS_SEND_HIGH_WATER_MARK_BYTES` — so the worst-case memory of one
     * connection differs by three orders of magnitude between them, and one
     * number could only be right for one of them.
     */
    WS_MAX_CONNECTIONS: z.coerce.number().int().positive().default(1_000),
    /**
     * The most rooms one connection may hold.
     *
     * This is a memory bound, not a usability one. An administrator may
     * subscribe to any `user:<id>` room, and room names are map keys held for
     * the life of the connection — so without a ceiling, one authenticated
     * client can make this process allocate a distinct key per `subscribe`
     * frame until it runs out of heap.
     */
    WS_MAX_ROOMS_PER_CONNECTION: z.coerce.number().int().positive().default(64),
    /**
     * Bytes of unflushed send buffer past which a connection stops being sent
     * events.
     *
     * `send()` on a peer that has stopped reading neither blocks nor fails — it
     * appends to a buffer that nothing bounds. 1 MiB is roughly five hundred
     * events at this application's payload sizes: comfortably more than any
     * ordinary burst, and small enough that a thousand stalled connections is a
     * gigabyte rather than the machine. See `docs/realtime.md`.
     */
    WS_SEND_HIGH_WATER_MARK_BYTES: z.coerce.number().int().positive().default(1_048_576),
    /**
     * How long a connection may stay over the high-water mark before it is
     * closed.
     *
     * The gap between "a burst it will catch up from" and "a peer that is not
     * reading". Ten seconds is long enough to cover a mobile radio handover and
     * short enough that a wedged client is not still holding a megabyte a
     * minute later.
     */
    WS_SLOW_CONSUMER_GRACE_MS: z.coerce.number().int().positive().default(10_000),
    /**
     * How often every connection is pinged, and the deadline for its pong.
     *
     * A WebSocket that has lost its peer is invisible at the application layer:
     * no events are due, nothing is written, and the operating system may hold
     * the TCP connection open for hours. The ping is what turns that into a
     * disconnect. It also paces the sweep that expires connections which fell
     * behind and then went quiet — see `docs/realtime.md`. Half the tightest
     * proxy idle timeout the SSE settings above are sized against, because a
     * WebSocket ping is not visible to the application and can afford to be
     * cheap.
     */
    WS_HEARTBEAT_INTERVAL_MS: z.coerce.number().int().positive().default(30_000),

    /**
     * Whether this replica advances sagas that nothing is currently driving.
     *
     * The union rather than `z.coerce.boolean()`, for the reason
     * `OUTBOX_RELAY_ENABLED` gives: coercion makes every non-empty string true,
     * so `=false` would enable the very thing it is spelled to turn off.
     *
     * Turning it off is a real deployment — recovery on dedicated workers, API
     * replicas doing only the in-request advance — and a dangerous one to reach
     * by accident, which is why the service logs a warning rather than a line
     * nobody reads when it starts up disabled. With every replica's poller off,
     * a saga interrupted between two steps stays where it stopped: money
     * captured and nothing shipped, indefinitely.
     */
    SAGA_RECOVERY_ENABLED: z
      .union([z.boolean(), z.enum(["true", "false", "1", "0"])])
      .default(true)
      .transform((value) => value === true || value === "true" || value === "1"),
    /**
     * How long an interrupted saga may sit before a poller picks it up.
     *
     * This is not latency on the happy path — `PlaceOrderHandler` advances the
     * saga in the request that created it — it is how quickly a retry or a
     * crashed replica is noticed.
     */
    SAGA_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(1_000),
    /** Instances claimed per pass. Each one is a chain of remote calls; keep it small. */
    SAGA_RECOVERY_BATCH_SIZE: z.coerce.number().int().positive().default(20),
    /**
     * How long a claim on a saga is good for.
     *
     * A lease rather than a row lock, because a step is an arbitrary remote call
     * and holding a Postgres transaction across one parks a connection on
     * somebody else's network. The number is a bet: too short and a runner is
     * replaced while its step is still legitimately running, too long and a
     * crashed replica's sagas are frozen until it expires. Thirty seconds is
     * three times the step timeout below, which the refinement enforces.
     */
    SAGA_LEASE_MS: z.coerce.number().int().positive().default(30_000),
    /**
     * How long one step may take before the orchestrator stops waiting.
     *
     * It bounds the *wait*, not the step — JavaScript has no cancellation, so a
     * call that eventually answers does so into a promise nobody is listening
     * to while its side effect at the other service happened anyway. That is
     * why every participant is idempotent on the step's key, and why this must
     * stay below `SAGA_LEASE_MS`.
     */
    SAGA_STEP_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
    /** First retry delay for a failing step, before jitter. The ladder doubles from here. */
    SAGA_BACKOFF_BASE_MS: z.coerce.number().int().positive().default(500),
    /** Ceiling on the retry delay, so the ladder plateaus rather than running away. */
    SAGA_BACKOFF_MAX_MS: z.coerce.number().int().positive().default(60_000),
    /**
     * Attempts a step gets before the saga gives up on it and turns around.
     *
     * Six with the defaults above is a little over a minute of retrying, which
     * is shorter than the outbox's twenty because a customer is waiting on the
     * other end of a checkout and a compensated order they can see beats a
     * spinner they cannot.
     */
    SAGA_MAX_ATTEMPTS: z.coerce.number().int().positive().default(6),

    /**
     * Attempts one outbound HTTP call gets, the first one included.
     *
     * Applies only to calls that may be replayed — a safe method, or a `POST`
     * carrying an idempotency key. `1` disables retrying without disabling the
     * breaker. Three is the usual shape: it covers the single dropped
     * connection and the one-off 503 without turning a dependency's bad minute
     * into three times the load on it.
     */
    HTTP_RETRY_MAX_ATTEMPTS: z.coerce.number().int().positive().default(3),
    /** Delay before the second attempt, before jitter. */
    HTTP_RETRY_BASE_MS: z.coerce.number().int().positive().default(200),
    /**
     * Ceiling on the un-jittered delay, and the longest `Retry-After` the
     * ladder will honour rather than give up on. Small, because somebody is
     * waiting on the request at the other end.
     */
    HTTP_RETRY_MAX_DELAY_MS: z.coerce.number().int().positive().default(2_000),
    /**
     * Share of failed calls in the rolling window, above which a dependency's
     * breaker opens.
     *
     * 50% rather than something stricter because the denominator counts only
     * calls that reached the dependency: a 4xx that is not 408 or 429 is the
     * dependency answering correctly and is not in it at all.
     */
    HTTP_BREAKER_FAILURE_THRESHOLD_PERCENT: z.coerce.number().int().min(1).max(100).default(50),
    /**
     * Calls the window must hold before the percentage is allowed to open the
     * breaker. Without it the first call of a quiet minute failing is a 100%
     * failure rate over a sample of one.
     */
    HTTP_BREAKER_VOLUME_THRESHOLD: z.coerce.number().int().positive().default(10),
    /** How much history the failure percentage is computed over. */
    HTTP_BREAKER_ROLLING_WINDOW_MS: z.coerce.number().int().positive().default(10_000),
    /**
     * Buckets the window is divided into; it advances one bucket at a time.
     * Must divide the window exactly — see the refinement below.
     */
    HTTP_BREAKER_ROLLING_BUCKETS: z.coerce.number().int().positive().default(10),
    /**
     * How long an open breaker rejects calls before letting one probe through.
     *
     * This is the number a caller waits out, so it is also the honest content
     * of the 503 they get: long enough for a dependency to finish restarting,
     * short enough that recovery is not gated on a deploy.
     */
    HTTP_BREAKER_RESET_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
    /**
     * Calls one dependency may have in flight at once.
     *
     * This is the bulkhead, and it exists for the dependency that is slow
     * rather than broken: the breaker needs finished failures before it can
     * react, and a gateway answering just inside its timeout never supplies
     * any. Twenty is roughly what a single instance can hold open against one
     * integration without its own inbound traffic queueing behind it, and it
     * is per dependency, so four integrations do not share one budget.
     */
    HTTP_BULKHEAD_MAX_CONCURRENT: z.coerce.number().int().positive().default(20),
    /**
     * Callers that may wait for a permit before requests are refused outright.
     *
     * Bounded, and bounded low, on purpose. An unbounded queue turns a
     * concurrency problem into a memory problem and hides it until the process
     * dies; a deep one fills with requests whose callers have already given up.
     */
    HTTP_BULKHEAD_MAX_QUEUED: z.coerce.number().int().nonnegative().default(20),
    /**
     * How long a call waits for a permit before being refused.
     *
     * A second, because a queue is worth having for the burst that clears in a
     * moment and not much else. Waiting longer than this against a saturated
     * dependency is time the caller could have spent being told no.
     */
    HTTP_BULKHEAD_QUEUE_TIMEOUT_MS: z.coerce.number().int().positive().default(1_000),
    /**
     * Hard ceiling on one outbound call, covering the queue wait, every
     * attempt, and every sleep between them.
     *
     * The per-attempt timeout bounds a socket; this bounds the call. Twenty-five
     * seconds fits one full ten-second attempt, a jittered sleep, and a second
     * full attempt, with room for a queue wait — a third attempt only happens
     * when the earlier ones failed fast, which is the case where it is cheap
     * and worth having. Callers with a tighter deadline of their own pass it
     * per call rather than lowering this.
     */
    HTTP_REQUEST_DEADLINE_MS: z.coerce.number().int().positive().default(25_000),

    /**
     * OpenTelemetry, spread in from `src/telemetry/telemetry.env.ts` rather
     * than written out here.
     *
     * These settings are read twice: by this schema, and by
     * `telemetry/register.ts`, which installs the SDK before Nest — and
     * therefore before `ConfigService` — exists. Sharing the declaration is
     * what stops the two from disagreeing about what a valid sampling ratio
     * is. See `docs/telemetry.md`.
     */
    ...telemetryEnvShape,
  })
  /**
   * Selecting a gateway without its credentials is a deployment that boots
   * happily and fails at the first checkout. Catching it here turns that into
   * a startup error naming the missing variable — the same reason every other
   * setting in this file is validated rather than read with `??`.
   *
   * Only the *selected* provider is required to be complete: leaving PayPal
   * unconfigured while running on Stripe is a normal deployment, and the
   * factory refuses the incomplete one if anything asks for it by name.
   */
  .superRefine((env, ctx) => {
    // The telemetry rules, shared with the pre-Nest bootstrap for the same
    // reason the shape above is.
    refineTelemetryEnv(env, env.NODE_ENV, ctx);

    /**
     * Selecting S3 without its credentials is a deployment that boots happily
     * and 503s on the first upload — the same failure the payment block below
     * exists to prevent, so it gets the same treatment.
     */
    if (env.STORAGE_ADAPTER === "s3") {
      for (const key of ["S3_BUCKET", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY"] as const) {
        if (!env[key]) {
          ctx.addIssue({
            code: "custom",
            path: [key],
            message: `${key} is required when STORAGE_ADAPTER=s3`,
          });
        }
      }
    }

    /**
     * The in-memory store is refused in production rather than warned about.
     *
     * Every other misconfiguration in this file produces an error someone can
     * see. This one does not: uploads succeed, downloads succeed, and the files
     * are gone after the next restart — silently, and only for objects written
     * before it. A default that is right for a test and catastrophic in
     * production has to be unable to reach production.
     */
    if (env.NODE_ENV === "production" && env.STORAGE_ADAPTER === "memory") {
      ctx.addIssue({
        code: "custom",
        path: ["STORAGE_ADAPTER"],
        message:
          "STORAGE_ADAPTER=memory loses every stored object on restart and must not be " +
          "used in production. Set STORAGE_ADAPTER=s3, or =local for a single-node deployment.",
      });
    }

    /**
     * The Redis-backed dedupe store has nothing to connect to without a URL,
     * and it would only find that out on the first request carrying an
     * `Idempotency-Key` — long after the deployment looked healthy.
     */
    if (env.IDEMPOTENCY_STORE === "redis" && !env.REDIS_URL) {
      ctx.addIssue({
        code: "custom",
        path: ["REDIS_URL"],
        message: "REDIS_URL is required when IDEMPOTENCY_STORE=redis",
      });
    }

    /**
     * Refused in production for the same reason `STORAGE_ADAPTER=memory` is,
     * only worse: a per-process store does not lose data visibly, it silently
     * stops deduplicating the moment a second replica exists — and the whole
     * point of the feature is that the second charge never happens.
     */
    if (env.NODE_ENV === "production" && env.IDEMPOTENCY_STORE === "memory") {
      ctx.addIssue({
        code: "custom",
        path: ["IDEMPOTENCY_STORE"],
        message:
          "IDEMPOTENCY_STORE=memory deduplicates within one process only and must not be " +
          "used in production. Set IDEMPOTENCY_STORE=redis and point REDIS_URL at a shared Redis.",
      });
    }

    /**
     * Redlock with nothing to vote over. Caught here rather than at the first
     * contended call, which may be days after the deployment looked healthy.
     */
    if (env.DISTRIBUTED_LOCK === "redlock" && !env.REDLOCK_NODES && !env.REDIS_URL) {
      ctx.addIssue({
        code: "custom",
        path: ["REDLOCK_NODES"],
        message:
          "REDLOCK_NODES (or REDIS_URL, for a single node) is required when DISTRIBUTED_LOCK=redlock",
      });
    }

    /**
     * Refused in production for the same reason `IDEMPOTENCY_STORE=memory` is:
     * it does not fail visibly. Every acquisition succeeds, every release
     * succeeds, and two replicas run the guarded operation at the same time —
     * which is the one thing the caller was written to assume cannot happen.
     */
    if (env.NODE_ENV === "production" && env.DISTRIBUTED_LOCK === "memory") {
      ctx.addIssue({
        code: "custom",
        path: ["DISTRIBUTED_LOCK"],
        message:
          "DISTRIBUTED_LOCK=memory excludes callers within one process only and must not be " +
          "used in production. Set DISTRIBUTED_LOCK=redlock and point REDLOCK_NODES at three " +
          "or more independent Redis masters.",
      });
    }

    /**
     * A Kafka client with nothing to bootstrap from. Caught here rather than at
     * the first produce, which on a service that publishes rarely may be hours
     * after the deployment looked healthy.
     */
    if (env.MESSAGE_BROKER === "kafka" && !env.KAFKA_BROKERS) {
      ctx.addIssue({
        code: "custom",
        path: ["KAFKA_BROKERS"],
        message: "KAFKA_BROKERS is required when MESSAGE_BROKER=kafka",
      });
    }

    /**
     * The in-process broker, refused in production the moment the relay depends
     * on it — and only then, because `MESSAGE_BROKER=memory` with
     * `OUTBOX_PUBLISHER=bus` is simply an unused broker, which is what a service
     * that has not adopted messaging yet has.
     *
     * With `OUTBOX_PUBLISHER=broker` it is the same class of failure as
     * `IDEMPOTENCY_STORE=memory`: nothing errors, every publish succeeds, and
     * the events reach subscribers in one process while every other replica and
     * every other service hears nothing. The configuration that looks like it
     * turned on cross-service messaging would have quietly turned on a longer
     * path to the same in-process bus.
     */
    if (
      env.NODE_ENV === "production" &&
      env.OUTBOX_PUBLISHER === "broker" &&
      env.MESSAGE_BROKER === "memory"
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["MESSAGE_BROKER"],
        message:
          "MESSAGE_BROKER=memory keeps every message inside one process and must not be used " +
          "in production with OUTBOX_PUBLISHER=broker. Set MESSAGE_BROKER=kafka and point " +
          "KAFKA_BROKERS at the cluster, or leave OUTBOX_PUBLISHER=bus.",
      });
    }

    /**
     * Half-configured SASL, treated like half-configured Twilio: somebody who
     * named a mechanism meant to authenticate, so say which half is missing at
     * boot rather than let the handshake fail against the broker later.
     */
    if (env.KAFKA_SASL_MECHANISM) {
      for (const key of ["KAFKA_SASL_USERNAME", "KAFKA_SASL_PASSWORD"] as const) {
        if (!env[key]) {
          ctx.addIssue({
            code: "custom",
            path: [key],
            message: `${key} is required when KAFKA_SASL_MECHANISM is set`,
          });
        }
      }
      /**
       * SASL/PLAIN puts the password on the wire in cleartext. SCRAM does not
       * and is safe without TLS in a way PLAIN is not, which is why only this
       * one mechanism is refused.
       */
      if (env.KAFKA_SASL_MECHANISM === "plain" && !env.KAFKA_SSL) {
        ctx.addIssue({
          code: "custom",
          path: ["KAFKA_SSL"],
          message:
            "KAFKA_SASL_MECHANISM=plain sends the password in cleartext and requires " +
            "KAFKA_SSL=true. Use scram-sha-256 or scram-sha-512 for an unencrypted connection.",
        });
      }
    }

    /**
     * A heartbeat interval at or above the session timeout guarantees eviction:
     * the coordinator gives up before the member's next heartbeat is due, so the
     * group rebalances continuously and no partition is read for long. Kafka's
     * own guidance is a third of the timeout; a third is a recommendation, but
     * *below it* is arithmetic.
     */
    if (env.KAFKA_HEARTBEAT_INTERVAL_MS >= env.KAFKA_SESSION_TIMEOUT_MS) {
      ctx.addIssue({
        code: "custom",
        path: ["KAFKA_HEARTBEAT_INTERVAL_MS"],
        message:
          `KAFKA_HEARTBEAT_INTERVAL_MS (${env.KAFKA_HEARTBEAT_INTERVAL_MS}) must be well below ` +
          `KAFKA_SESSION_TIMEOUT_MS (${env.KAFKA_SESSION_TIMEOUT_MS}); Kafka's guidance is at ` +
          `most a third of it, so a member survives a lost heartbeat.`,
      });
    }

    /**
     * The retry ladder runs *inside* one `handle()` call, and `handle()` is
     * bounded by `KAFKA_HANDLER_TIMEOUT_MS`. A ladder whose sleeps alone outlast
     * that bound can therefore never reach its last attempt: the handler is cut
     * off mid-ladder, the message is redelivered by the broker with a fresh
     * budget, and it never reaches the dead-letter topic — a poison message
     * blocking its partition forever, under a configuration that reads as though
     * it had been given five tries and a way out.
     *
     * `worstCaseLadderMs` is the sum of the un-jittered ceilings, so this is the
     * necessary condition rather than the sufficient one: the attempts
     * themselves also take time, and how much is up to the handler. Checked with
     * room to spare rather than at equality for that reason.
     */
    const ladderMs = worstCaseLadderMs({
      maxAttempts: env.KAFKA_RETRY_MAX_ATTEMPTS,
      baseMs: env.KAFKA_RETRY_BASE_MS,
      maxMs: env.KAFKA_RETRY_MAX_DELAY_MS,
    });
    if (ladderMs * 2 >= env.KAFKA_HANDLER_TIMEOUT_MS) {
      ctx.addIssue({
        code: "custom",
        path: ["KAFKA_RETRY_MAX_ATTEMPTS"],
        message:
          `The retry ladder can sleep for up to ${ladderMs}ms, which leaves too little of ` +
          `KAFKA_HANDLER_TIMEOUT_MS (${env.KAFKA_HANDLER_TIMEOUT_MS}ms) for the attempts ` +
          `themselves. The ladder runs inside one handler call, so a handler cut off ` +
          `mid-ladder is redelivered with a fresh budget and never reaches the dead-letter ` +
          `topic. Lower KAFKA_RETRY_MAX_ATTEMPTS or KAFKA_RETRY_MAX_DELAY_MS, or raise ` +
          `KAFKA_HANDLER_TIMEOUT_MS to more than ${ladderMs * 2}ms.`,
      });
    }

    /**
     * A dead-letter topic that is also the source topic is an infinite loop: the
     * consumer reads its own dead letters, fails on them again, and republishes
     * them, growing the topic without bound. Nothing else in the pipeline would
     * report it as an error.
     */
    if (
      env.KAFKA_DEAD_LETTER_ENABLED &&
      env.KAFKA_DEAD_LETTER_TOPIC === env.KAFKA_DOMAIN_EVENTS_TOPIC
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["KAFKA_DEAD_LETTER_TOPIC"],
        message:
          `KAFKA_DEAD_LETTER_TOPIC must not be KAFKA_DOMAIN_EVENTS_TOPIC ` +
          `("${env.KAFKA_DOMAIN_EVENTS_TOPIC}"): the consumer would read back every message ` +
          `it gave up on, fail on it again, and republish it forever.`,
      });
    }

    if (env.PAYMENTS_PROVIDER === "stripe" && !env.STRIPE_SECRET_KEY) {
      ctx.addIssue({
        code: "custom",
        path: ["STRIPE_SECRET_KEY"],
        message: "STRIPE_SECRET_KEY is required when PAYMENTS_PROVIDER=stripe",
      });
    }

    if (env.PAYMENTS_PROVIDER === "paypal") {
      for (const key of ["PAYPAL_CLIENT_ID", "PAYPAL_CLIENT_SECRET"] as const) {
        if (!env[key]) {
          ctx.addIssue({
            code: "custom",
            path: [key],
            message: `${key} is required when PAYMENTS_PROVIDER=paypal`,
          });
        }
      }
    }

    /**
     * SMS is optional, but half-configured SMS is not: the channel needs an
     * account, a token and something to send from, and missing any one of them
     * makes it silently unavailable. Someone who set two of the three meant to
     * enable it, so say which one is missing at boot rather than let every SMS
     * be skipped as `not-configured` in production.
     */
    const twilio = {
      TWILIO_ACCOUNT_SID: env.TWILIO_ACCOUNT_SID,
      TWILIO_AUTH_TOKEN: env.TWILIO_AUTH_TOKEN,
      sender: env.TWILIO_FROM_NUMBER ?? env.TWILIO_MESSAGING_SERVICE_SID,
    };
    if (Object.values(twilio).some(Boolean)) {
      for (const key of ["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN"] as const) {
        if (!env[key]) {
          ctx.addIssue({
            code: "custom",
            path: [key],
            message: `${key} is required when any other Twilio credential is set`,
          });
        }
      }
      if (!twilio.sender) {
        ctx.addIssue({
          code: "custom",
          path: ["TWILIO_FROM_NUMBER"],
          message:
            "TWILIO_FROM_NUMBER or TWILIO_MESSAGING_SERVICE_SID is required when any " +
            "other Twilio credential is set",
        });
      }
    }

    /**
     * A lease shorter than the step it covers is the one saga misconfiguration
     * that produces a *correctness* failure rather than a slow one, and it does
     * it quietly. The orchestrator stops waiting for a step at
     * `SAGA_STEP_TIMEOUT_MS` and treats it as failed; the lease is what stops a
     * second runner starting the same step in the meantime. Set the lease
     * shorter and every step that runs long enough to matter is executed twice,
     * concurrently, by two runners that both believe they hold the saga — a
     * double charge under a configuration that reads as though it were merely
     * impatient.
     *
     * Checked with a margin rather than at equality: the lease has to cover the
     * step *and* the write that records it, and that write is a database round
     * trip nobody has bounded here.
     */
    if (env.SAGA_LEASE_MS <= env.SAGA_STEP_TIMEOUT_MS * 2) {
      ctx.addIssue({
        code: "custom",
        path: ["SAGA_LEASE_MS"],
        message:
          `SAGA_LEASE_MS (${env.SAGA_LEASE_MS}ms) must be more than twice ` +
          `SAGA_STEP_TIMEOUT_MS (${env.SAGA_STEP_TIMEOUT_MS}ms). A lease that can expire ` +
          `while a step is still running lets a second runner start the same step, which ` +
          `for a payment means charging twice. Raise SAGA_LEASE_MS above ` +
          `${env.SAGA_STEP_TIMEOUT_MS * 2}ms, or lower SAGA_STEP_TIMEOUT_MS.`,
      });
    }

    /**
     * Opossum divides the rolling window into buckets with integer division and
     * rotates one every `window / buckets` milliseconds. A window smaller than
     * its bucket count floors that to zero, and `setInterval(0)` is a timer
     * that fires as fast as the event loop will let it — on every breaker, for
     * the life of the process. It surfaces as CPU nobody can account for rather
     * than as an error, and it is arithmetic this file can do at boot.
     *
     * Only the degenerate case is refused. A window that divides unevenly loses
     * at most one bucket-interval of history, which is a rounding difference
     * and not worth refusing a deployment over.
     */
    if (env.HTTP_BREAKER_ROLLING_WINDOW_MS < env.HTTP_BREAKER_ROLLING_BUCKETS) {
      ctx.addIssue({
        code: "custom",
        path: ["HTTP_BREAKER_ROLLING_WINDOW_MS"],
        message:
          `HTTP_BREAKER_ROLLING_WINDOW_MS (${env.HTTP_BREAKER_ROLLING_WINDOW_MS}ms) must be at ` +
          `least HTTP_BREAKER_ROLLING_BUCKETS (${env.HTTP_BREAKER_ROLLING_BUCKETS}): the ` +
          `breaker rotates one bucket at a time, and a bucket shorter than a millisecond is a ` +
          `timer that never stops firing.`,
      });
    }

    /**
     * The request budget has to outlast the queue wait, or the bulkhead is the
     * only thing a contended call ever reaches: it waits the full queue
     * timeout, is admitted, finds nothing left of its deadline, and gives up
     * without sending anything. Every call under contention would then be a
     * 504 no matter how healthy the dependency is — the most confusing possible
     * shape for this failure, and arithmetic this file can do at boot.
     */
    if (env.HTTP_REQUEST_DEADLINE_MS <= env.HTTP_BULKHEAD_QUEUE_TIMEOUT_MS) {
      ctx.addIssue({
        code: "custom",
        path: ["HTTP_REQUEST_DEADLINE_MS"],
        message:
          `HTTP_REQUEST_DEADLINE_MS (${env.HTTP_REQUEST_DEADLINE_MS}ms) must be greater than ` +
          `HTTP_BULKHEAD_QUEUE_TIMEOUT_MS (${env.HTTP_BULKHEAD_QUEUE_TIMEOUT_MS}ms): a call that ` +
          `may spend its whole budget queueing for a permit can never spend any of it on a ` +
          `request.`,
      });
    }
  });

export type Env = z.infer<typeof envSchema>;
