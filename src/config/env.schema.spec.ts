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
