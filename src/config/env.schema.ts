import { z } from "zod";
import { IDEMPOTENCY_STORE_NAMES } from "@/common/idempotency/ports";
import { DISTRIBUTED_LOCK_NAMES } from "@/common/locking/ports";
import { PAYMENT_PROVIDER_NAMES } from "@/payments/ports";
import { STORAGE_ADAPTER_NAMES } from "@/storage/ports";
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
  });

export type Env = z.infer<typeof envSchema>;
