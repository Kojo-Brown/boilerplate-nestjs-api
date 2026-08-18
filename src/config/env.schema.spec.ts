import { envSchema } from "./env.schema";

const BASE_ENV = {
  DATABASE_URL: "postgresql://postgres:postgres@localhost:5432/app_db",
  JWT_SECRET: "test-secret-that-is-at-least-32-chars",
};

describe("envSchema — payments", () => {
  it("defaults to the mock gateway and the public API hosts", () => {
    const env = envSchema.parse(BASE_ENV);

    expect(env.PAYMENTS_PROVIDER).toBe("mock");
    expect(env.STRIPE_API_BASE_URL).toBe("https://api.stripe.com");
    // Sandbox, so a boilerplate that is run without thinking cannot move money.
    expect(env.PAYPAL_API_BASE_URL).toBe("https://api-m.sandbox.paypal.com");
  });

  it("rejects a gateway that has no implementation", () => {
    expect(() => envSchema.parse({ ...BASE_ENV, PAYMENTS_PROVIDER: "adyen" })).toThrow();
  });

  it("refuses to boot on Stripe without a secret key", () => {
    // The failure this prevents is a deploy that starts happily and only falls
    // over at the first checkout.
    expect(() => envSchema.parse({ ...BASE_ENV, PAYMENTS_PROVIDER: "stripe" })).toThrow(
      /STRIPE_SECRET_KEY is required when PAYMENTS_PROVIDER=stripe/,
    );
  });

  it("accepts Stripe once the secret key is present", () => {
    const env = envSchema.parse({
      ...BASE_ENV,
      PAYMENTS_PROVIDER: "stripe",
      STRIPE_SECRET_KEY: "sk_test_fake_key_for_unit_tests",
    });

    expect(env.PAYMENTS_PROVIDER).toBe("stripe");
  });

  it("refuses to boot on PayPal without both halves of the credential", () => {
    expect(() =>
      envSchema.parse({
        ...BASE_ENV,
        PAYMENTS_PROVIDER: "paypal",
        PAYPAL_CLIENT_ID: "fake-paypal-client-id",
      }),
    ).toThrow(/PAYPAL_CLIENT_SECRET is required/);

    expect(() => envSchema.parse({ ...BASE_ENV, PAYMENTS_PROVIDER: "paypal" })).toThrow(
      /PAYPAL_CLIENT_ID is required/,
    );
  });

  it("does not require credentials for a gateway that is merely available", () => {
    // Running on Stripe with PayPal left unconfigured is a normal deployment;
    // only the selected gateway has to be complete.
    expect(() =>
      envSchema.parse({
        ...BASE_ENV,
        PAYMENTS_PROVIDER: "mock",
        STRIPE_SECRET_KEY: undefined,
        PAYPAL_CLIENT_ID: undefined,
      }),
    ).not.toThrow();
  });

  it("still validates everything it validated before", () => {
    expect(() => envSchema.parse({ ...BASE_ENV, DATABASE_URL: "not-a-url" })).toThrow();
    expect(() => envSchema.parse({ ...BASE_ENV, JWT_SECRET: "too-short" })).toThrow();
  });
});

describe("envSchema — notifications", () => {
  const TWILIO = {
    TWILIO_ACCOUNT_SID: "ACfake00000000000000000000000000",
    TWILIO_AUTH_TOKEN: "fake-twilio-auth-token",
    TWILIO_FROM_NUMBER: "+15550000000",
  };

  it("defaults to the public API hosts with every channel credential unset", () => {
    const env = envSchema.parse(BASE_ENV);

    expect(env.TWILIO_API_BASE_URL).toBe("https://api.twilio.com");
    expect(env.EXPO_PUSH_API_BASE_URL).toBe("https://exp.host");
    expect(env.TWILIO_ACCOUNT_SID).toBeUndefined();
    expect(env.EXPO_ACCESS_TOKEN).toBeUndefined();
  });

  it("accepts an app with no notification credentials at all", () => {
    // Every channel is optional: an unconfigured one is skipped at dispatch,
    // not a boot failure, so an app with only email still starts.
    expect(() => envSchema.parse(BASE_ENV)).not.toThrow();
  });

  it("accepts a complete Twilio configuration", () => {
    expect(() => envSchema.parse({ ...BASE_ENV, ...TWILIO })).not.toThrow();
  });

  it("accepts a messaging service in place of a sending number", () => {
    expect(() =>
      envSchema.parse({
        ...BASE_ENV,
        ...TWILIO,
        TWILIO_FROM_NUMBER: undefined,
        TWILIO_MESSAGING_SERVICE_SID: "MGfake00000000000000000000000000",
      }),
    ).not.toThrow();
  });

  it.each(["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN"] as const)(
    "refuses a half-configured Twilio missing %s",
    (missing) => {
      // Setting two of the three means someone meant to enable SMS. Booting
      // anyway would make every SMS silently `not-configured` in production.
      expect(() => envSchema.parse({ ...BASE_ENV, ...TWILIO, [missing]: undefined })).toThrow(
        new RegExp(`${missing} is required`),
      );
    },
  );

  it("refuses a Twilio account with nothing to send from", () => {
    expect(() =>
      envSchema.parse({ ...BASE_ENV, ...TWILIO, TWILIO_FROM_NUMBER: undefined }),
    ).toThrow(/TWILIO_FROM_NUMBER or TWILIO_MESSAGING_SERVICE_SID is required/);
  });

  it("does not treat the Twilio base URL default as a credential", () => {
    // `TWILIO_API_BASE_URL` has a default, so it is always set after parsing.
    // If the completeness check keyed off it, every app would demand Twilio.
    expect(() => envSchema.parse(BASE_ENV)).not.toThrow();
  });

  it("leaves push disabled rather than failing when no access token is set", () => {
    const env = envSchema.parse({ ...BASE_ENV, EXPO_PUSH_API_BASE_URL: "https://exp.host" });

    expect(env.EXPO_ACCESS_TOKEN).toBeUndefined();
  });

  it("rejects a non-URL push endpoint", () => {
    expect(() => envSchema.parse({ ...BASE_ENV, EXPO_PUSH_API_BASE_URL: "exp.host" })).toThrow();
  });
});

describe("envSchema — storage", () => {
  it("defaults to the in-memory adapter so a clean clone boots with no configuration", () => {
    const env = envSchema.parse(BASE_ENV);

    expect(env.STORAGE_ADAPTER).toBe("memory");
    expect(env.STORAGE_LOCAL_ROOT).toBe("./storage");
  });

  it("rejects a backend that has no adapter", () => {
    expect(() => envSchema.parse({ ...BASE_ENV, STORAGE_ADAPTER: "azure" })).toThrow();
  });

  it("refuses to boot on S3 without credentials, naming each missing variable", () => {
    // The failure this prevents is a deploy that starts happily and 503s on the
    // first upload.
    expect(() => envSchema.parse({ ...BASE_ENV, STORAGE_ADAPTER: "s3" })).toThrow(
      /S3_BUCKET is required when STORAGE_ADAPTER=s3/,
    );
  });

  it("accepts S3 once every credential is present", () => {
    const env = envSchema.parse({
      ...BASE_ENV,
      STORAGE_ADAPTER: "s3",
      S3_BUCKET: "app-uploads",
      S3_ACCESS_KEY_ID: "fake-access-key-id",
      S3_SECRET_ACCESS_KEY: "fake-secret-access-key",
    });

    expect(env.STORAGE_ADAPTER).toBe("s3");
    expect(env.S3_REGION).toBe("us-east-1");
  });

  it("does not require S3 credentials for the other backends", () => {
    // Selecting one adapter must not drag in another's configuration — that is
    // the point of selecting rather than configuring all three.
    expect(envSchema.parse({ ...BASE_ENV, STORAGE_ADAPTER: "local" }).STORAGE_ADAPTER).toBe(
      "local",
    );
  });

  it("refuses the in-memory adapter in production", () => {
    // Unlike every other misconfiguration here, this one produces no error at
    // runtime: uploads succeed and the files are simply gone after a restart.
    expect(() =>
      envSchema.parse({ ...BASE_ENV, NODE_ENV: "production", STORAGE_ADAPTER: "memory" }),
    ).toThrow(/loses every stored object on restart/);
  });

  it("refuses the in-memory adapter in production even by default", () => {
    // The default is the dangerous value, so leaving it unset must fail too.
    expect(() => envSchema.parse({ ...BASE_ENV, NODE_ENV: "production" })).toThrow(
      /STORAGE_ADAPTER=memory/,
    );
  });

  it("allows the local disk in production, since a single node is a real deployment", () => {
    const env = envSchema.parse({
      ...BASE_ENV,
      NODE_ENV: "production",
      STORAGE_ADAPTER: "local",
      STORAGE_LOCAL_ROOT: "/var/lib/app/storage",
      // Unrelated to storage, but production refuses the in-memory idempotency
      // store and the in-memory lock too, and this test is about the storage
      // rule on its own.
      IDEMPOTENCY_STORE: "redis",
      DISTRIBUTED_LOCK: "redlock",
      REDIS_URL: "redis://localhost:6379",
    });

    expect(env.STORAGE_LOCAL_ROOT).toBe("/var/lib/app/storage");
  });

  it("allows the in-memory adapter in test and development", () => {
    for (const NODE_ENV of ["test", "development"] as const) {
      expect(envSchema.parse({ ...BASE_ENV, NODE_ENV }).STORAGE_ADAPTER).toBe("memory");
    }
  });
});

describe("envSchema — idempotency", () => {
  it("defaults to the in-memory store and a 24-hour window", () => {
    const env = envSchema.parse(BASE_ENV);

    expect(env.IDEMPOTENCY_STORE).toBe("memory");
    expect(env.IDEMPOTENCY_TTL_SECONDS).toBe(86_400);
  });

  it("coerces the TTL from the string an environment actually supplies", () => {
    expect(
      envSchema.parse({ ...BASE_ENV, IDEMPOTENCY_TTL_SECONDS: "600" }).IDEMPOTENCY_TTL_SECONDS,
    ).toBe(600);
  });

  it.each(["0", "-1", "1.5", "not-a-number"])("rejects a TTL of %s", (value) => {
    // A zero or negative window would expire every record the instant it was
    // written, which looks exactly like the feature being switched off.
    expect(() => envSchema.parse({ ...BASE_ENV, IDEMPOTENCY_TTL_SECONDS: value })).toThrow();
  });

  it("refuses to boot on Redis without a URL", () => {
    // Otherwise the deployment looks healthy and only finds out on the first
    // request carrying an Idempotency-Key.
    expect(() => envSchema.parse({ ...BASE_ENV, IDEMPOTENCY_STORE: "redis" })).toThrow(
      /REDIS_URL is required when IDEMPOTENCY_STORE=redis/,
    );
  });

  it("accepts Redis once the URL is present", () => {
    const env = envSchema.parse({
      ...BASE_ENV,
      IDEMPOTENCY_STORE: "redis",
      REDIS_URL: "redis://localhost:6379",
    });

    expect(env.IDEMPOTENCY_STORE).toBe("redis");
  });

  it("refuses the in-memory store in production even by default", () => {
    // The default is the dangerous value. A per-process store stops
    // deduplicating the moment a second replica exists, and does it silently.
    expect(() =>
      envSchema.parse({ ...BASE_ENV, NODE_ENV: "production", STORAGE_ADAPTER: "local" }),
    ).toThrow(/IDEMPOTENCY_STORE=memory/);
  });

  it("allows the in-memory store in test and development", () => {
    for (const NODE_ENV of ["test", "development"] as const) {
      expect(envSchema.parse({ ...BASE_ENV, NODE_ENV }).IDEMPOTENCY_STORE).toBe("memory");
    }
  });
});

describe("envSchema — distributed lock", () => {
  it("defaults to the in-memory lock, so a clean clone boots with nothing configured", () => {
    expect(envSchema.parse(BASE_ENV).DISTRIBUTED_LOCK).toBe("memory");
  });

  it("rejects an implementation that does not exist", () => {
    expect(() => envSchema.parse({ ...BASE_ENV, DISTRIBUTED_LOCK: "zookeeper" })).toThrow();
  });

  it("refuses Redlock with nothing to vote over", () => {
    // Otherwise the deployment looks healthy and finds out at the first
    // contended call, which may be days later.
    expect(() => envSchema.parse({ ...BASE_ENV, DISTRIBUTED_LOCK: "redlock" })).toThrow(
      /REDLOCK_NODES \(or REDIS_URL, for a single node\) is required/,
    );
  });

  it.each([
    ["REDLOCK_NODES", { REDLOCK_NODES: "redis://a:6379,redis://b:6379,redis://c:6379" }],
    ["REDIS_URL alone", { REDIS_URL: "redis://localhost:6379" }],
  ])("accepts Redlock configured through %s", (_why, extra) => {
    const env = envSchema.parse({ ...BASE_ENV, DISTRIBUTED_LOCK: "redlock", ...extra });

    expect(env.DISTRIBUTED_LOCK).toBe("redlock");
  });

  it("refuses the in-memory lock in production even by default", () => {
    // The default is the dangerous value, and it is dangerous silently: every
    // acquisition succeeds on every replica.
    expect(() =>
      envSchema.parse({
        ...BASE_ENV,
        NODE_ENV: "production",
        STORAGE_ADAPTER: "local",
        IDEMPOTENCY_STORE: "redis",
        REDIS_URL: "redis://localhost:6379",
      }),
    ).toThrow(/DISTRIBUTED_LOCK=memory/);
  });

  it("allows the in-memory lock in test and development", () => {
    for (const NODE_ENV of ["test", "development"] as const) {
      expect(envSchema.parse({ ...BASE_ENV, NODE_ENV }).DISTRIBUTED_LOCK).toBe("memory");
    }
  });
});
