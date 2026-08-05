import { Test } from "@nestjs/testing";
import type { TestingModule } from "@nestjs/testing";
import { ConfigModule } from "@nestjs/config";
import { PaymentProviderFactory } from "./payment-provider.factory";
import { PaymentProviderNotConfiguredError, UnknownPaymentProviderError } from "./payment.errors";
import { PAYMENT_PROVIDERS } from "./ports";
import type { Payment, PaymentProvider, PaymentProviderName } from "./ports";
import { MockPaymentProvider } from "./providers/mock-payment.provider";
import { PaypalPaymentProvider } from "./providers/paypal-payment.provider";
import { StripePaymentProvider } from "./providers/stripe-payment.provider";
import { PaymentsModule } from "./payments.module";
import { stubConfig } from "@/test-utils/stub-config";

/** A provider that does nothing but answer to a name — the factory's whole input. */
function fakeProvider(name: PaymentProviderName, isConfigured = true): PaymentProvider {
  const unimplemented = (): Promise<never> => Promise.reject(new Error("not called"));
  return {
    name,
    isConfigured,
    authorize: unimplemented,
    capture: unimplemented,
    refund: unimplemented,
    find: (): Promise<Payment | null> => Promise.resolve(null),
  };
}

function buildFactory(
  env: Record<string, string | undefined>,
  providers: PaymentProvider[],
): PaymentProviderFactory {
  return new PaymentProviderFactory(stubConfig(env), providers);
}

/**
 * Compiles the real module against a real `ConfigService`.
 *
 * `ConfigModule` is global in `AppModule`, so `PaymentsModule` declares no
 * config import of its own; the test has to supply the same global. Loading the
 * values through a factory — rather than overriding `ConfigService` — is what
 * makes this an integration check of the module's own wiring.
 */
async function compilePaymentsModule(
  env: Record<string, string | undefined>,
): Promise<TestingModule> {
  return Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({
        isGlobal: true,
        ignoreEnvFile: true,
        load: [(): Record<string, string | undefined> => env],
      }),
      PaymentsModule,
    ],
  }).compile();
}

describe("PaymentProviderFactory", () => {
  describe("default resolution", () => {
    it("hands out the provider named by PAYMENTS_PROVIDER", () => {
      const factory = buildFactory({ PAYMENTS_PROVIDER: "stripe" }, [
        fakeProvider("mock"),
        fakeProvider("stripe"),
      ]);

      expect(factory.defaultProvider.name).toBe("stripe");
      expect(factory.defaultProviderName).toBe("stripe");
    });

    it("falls back to the mock when PAYMENTS_PROVIDER is unset", () => {
      const factory = buildFactory({}, [fakeProvider("mock"), fakeProvider("stripe")]);

      expect(factory.defaultProvider.name).toBe("mock");
    });

    it("refuses to construct when PAYMENTS_PROVIDER names something unregistered", () => {
      expect(() => buildFactory({ PAYMENTS_PROVIDER: "adyen" }, [fakeProvider("mock")])).toThrow(
        /not a registered provider/,
      );
    });

    it("refuses to construct when PAYMENTS_PROVIDER is a known name with no implementation", () => {
      // The env schema accepts "paypal"; if the module forgot to register it,
      // that must fail at boot rather than at the first checkout.
      expect(() => buildFactory({ PAYMENTS_PROVIDER: "paypal" }, [fakeProvider("mock")])).toThrow(
        /not a registered provider/,
      );
    });

    it("refuses to construct when two providers claim the same name", () => {
      expect(() => buildFactory({}, [fakeProvider("mock"), fakeProvider("mock")])).toThrow(
        /Duplicate payment provider/,
      );
    });
  });

  describe("resolve()", () => {
    const providers = [fakeProvider("mock"), fakeProvider("stripe"), fakeProvider("paypal", false)];

    it("resolves a provider by name, overriding the default", () => {
      const factory = buildFactory({ PAYMENTS_PROVIDER: "mock" }, providers);

      expect(factory.resolve("stripe").name).toBe("stripe");
    });

    it("returns the default for undefined and for null", () => {
      const factory = buildFactory({ PAYMENTS_PROVIDER: "stripe" }, providers);

      expect(factory.resolve().name).toBe("stripe");
      expect(factory.resolve(null).name).toBe("stripe");
    });

    it("rejects an unknown name as caller error, not a server error", () => {
      const factory = buildFactory({}, providers);

      // 400: the name came from a request, so it is the caller's mistake.
      expect(() => factory.resolve("adyen")).toThrow(UnknownPaymentProviderError);
      expect(() => factory.resolve("adyen")).toThrow(/Available: mock, stripe, paypal/);
    });

    it("rejects a registered provider that has no credentials", () => {
      const factory = buildFactory({}, providers);

      // 503, and it names the variables to set — an operator problem.
      expect(() => factory.resolve("paypal")).toThrow(PaymentProviderNotConfiguredError);
      expect(() => factory.resolve("paypal")).toThrow(/PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET/);
    });

    it("names STRIPE_SECRET_KEY when Stripe is the unconfigured one", () => {
      const factory = buildFactory({}, [fakeProvider("mock"), fakeProvider("stripe", false)]);

      expect(() => factory.resolve("stripe")).toThrow(/STRIPE_SECRET_KEY/);
    });
  });

  describe("introspection", () => {
    it("separates what is registered from what is usable", () => {
      const factory = buildFactory({}, [
        fakeProvider("mock"),
        fakeProvider("stripe", false),
        fakeProvider("paypal"),
      ]);

      expect(factory.registered).toEqual(["mock", "stripe", "paypal"]);
      expect(factory.available).toEqual(["mock", "paypal"]);
    });
  });

  describe("wired through PaymentsModule", () => {
    it("registers all three providers and resolves the configured default", async () => {
      const moduleRef = await compilePaymentsModule({ PAYMENTS_PROVIDER: "mock" });

      const factory = moduleRef.get(PaymentProviderFactory);

      expect(factory.registered).toEqual(["mock", "stripe", "paypal"]);
      expect(factory.defaultProvider).toBeInstanceOf(MockPaymentProvider);
      // Registered but unusable without credentials, which is the normal state
      // for a boilerplate checkout: mock works, the real gateways wait for env.
      expect(factory.available).toEqual(["mock"]);
    });

    it("hands out the real adapters once their credentials are present", async () => {
      const moduleRef = await compilePaymentsModule({
        PAYMENTS_PROVIDER: "stripe",
        STRIPE_SECRET_KEY: "sk_test_fake_key_for_unit_tests",
        PAYPAL_CLIENT_ID: "fake-paypal-client-id",
        PAYPAL_CLIENT_SECRET: "fake-paypal-client-secret",
      });

      const factory = moduleRef.get(PaymentProviderFactory);

      expect(factory.defaultProvider).toBeInstanceOf(StripePaymentProvider);
      expect(factory.resolve("paypal")).toBeInstanceOf(PaypalPaymentProvider);
      expect(factory.available).toEqual(["mock", "stripe", "paypal"]);
    });

    it("does not export the concrete providers", async () => {
      const moduleRef = await compilePaymentsModule({});

      // The collection token stays internal too: consumers get the factory and
      // the port, and nothing else.
      expect(() => moduleRef.get(PAYMENT_PROVIDERS, { strict: true })).toThrow();
    });
  });
});
