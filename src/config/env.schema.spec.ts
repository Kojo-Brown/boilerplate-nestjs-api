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
