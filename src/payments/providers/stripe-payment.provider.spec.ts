import { HttpStatus } from "@nestjs/common";
import { PaymentProviderError, PaymentProviderNotConfiguredError } from "../payment.errors";
import { StripePaymentProvider } from "./stripe-payment.provider";
import { FakeStripeApi } from "@/test-utils/fake-stripe-api";
import { stubConfig } from "@/test-utils/stub-config";

const BASE_URL = "https://stripe.test";
const SECRET_KEY = "sk_test_fake_key_for_unit_tests";

const AMOUNT = { amountMinor: 2500, currency: "EUR" };

const realFetch = global.fetch;

function buildProvider(env: Record<string, string | undefined> = {}): StripePaymentProvider {
  return new StripePaymentProvider(
    stubConfig({ STRIPE_SECRET_KEY: SECRET_KEY, STRIPE_API_BASE_URL: BASE_URL, ...env }),
  );
}

/** Answers every request with one canned response — for the error paths. */
function respondWith(status: number, body: unknown): jest.Mock {
  const mock = jest.fn(
    async () =>
      new Response(typeof body === "string" ? body : JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      }),
  );
  global.fetch = mock as unknown as typeof fetch;
  return mock;
}

describe("StripePaymentProvider", () => {
  let api: FakeStripeApi;

  beforeEach(() => {
    api = new FakeStripeApi(BASE_URL, SECRET_KEY);
    global.fetch = api.fetch;
  });

  afterEach(() => {
    global.fetch = realFetch;
  });

  describe("when STRIPE_SECRET_KEY is absent", () => {
    it("constructs, reports itself unconfigured, and refuses every call", async () => {
      const provider = new StripePaymentProvider(stubConfig({}));

      // Nest instantiates providers eagerly, so an unconfigured Stripe must not
      // throw at construction — only when something actually asks it to work.
      expect(provider.isConfigured).toBe(false);
      await expect(provider.authorize({ amount: AMOUNT, reference: "order-1" })).rejects.toThrow(
        PaymentProviderNotConfiguredError,
      );
      await expect(provider.capture("pi_test_1")).rejects.toThrow(
        PaymentProviderNotConfiguredError,
      );
      await expect(provider.refund("pi_test_1")).rejects.toThrow(PaymentProviderNotConfiguredError);
      await expect(provider.find("pi_test_1")).rejects.toThrow(PaymentProviderNotConfiguredError);
    });
  });

  describe("authorize()", () => {
    it("creates a manual-capture intent with the amount in minor units", async () => {
      await buildProvider().authorize({ amount: AMOUNT, reference: "order-1" });

      const request = api.requests.at(-1);
      expect(request?.path).toBe("/v1/payment_intents");
      expect(request?.form.get("amount")).toBe("2500");
      // Stripe wants a lower-case currency; the domain holds it upper-case.
      expect(request?.form.get("currency")).toBe("eur");
      // Without this the intent charges immediately and the port's
      // authorize/capture split would be a fiction.
      expect(request?.form.get("capture_method")).toBe("manual");
      expect(request?.form.get("metadata[reference]")).toBe("order-1");
      expect(request?.form.get("expand[]")).toBe("latest_charge");
    });

    it("sends the idempotency key and bearer token", async () => {
      await buildProvider().authorize({ amount: AMOUNT, reference: "order-1" });

      const request = api.requests.at(-1);
      expect(request?.headers["idempotency-key"]).toBe("authorize:order-1");
      expect(request?.headers.authorization).toBe(`Bearer ${SECRET_KEY}`);
    });

    it("omits Stripe-Version unless one is configured", async () => {
      await buildProvider().authorize({ amount: AMOUNT, reference: "order-1" });

      // Without the header Stripe uses the account's own pinned version, which
      // is safer than shipping a dated string that may not exist.
      expect(api.requests.at(-1)?.headers["stripe-version"]).toBeUndefined();
    });

    it("pins the API version when the environment sets one", async () => {
      await buildProvider({ STRIPE_API_VERSION: "2099-01-01" }).authorize({
        amount: AMOUNT,
        reference: "order-1",
      });

      expect(api.requests.at(-1)?.headers["stripe-version"]).toBe("2099-01-01");
    });

    it("passes the description and receipt email when given", async () => {
      await buildProvider().authorize({
        amount: AMOUNT,
        reference: "order-1",
        description: "Two widgets",
        customerEmail: "buyer@example.test",
      });

      const request = api.requests.at(-1);
      expect(request?.form.get("description")).toBe("Two widgets");
      expect(request?.form.get("receipt_email")).toBe("buyer@example.test");
    });

    it("omits the optional fields entirely when they are not", async () => {
      await buildProvider().authorize({ amount: AMOUNT, reference: "order-1" });

      const request = api.requests.at(-1);
      expect(request?.form.has("description")).toBe(false);
      expect(request?.form.has("receipt_email")).toBe(false);
    });

    it("tolerates a base URL with a trailing slash", async () => {
      const provider = buildProvider({ STRIPE_API_BASE_URL: `${BASE_URL}/` });

      await expect(
        provider.authorize({ amount: AMOUNT, reference: "order-1" }),
      ).resolves.toMatchObject({ status: "authorized" });
    });
  });

  describe("refund()", () => {
    it("always sends an explicit amount, even for a full refund", async () => {
      const provider = buildProvider();
      const payment = await provider.authorize({ amount: AMOUNT, reference: "order-1" });
      await provider.capture(payment.id);

      await provider.refund(payment.id);

      // The amount is resolved locally from the payment rather than left to
      // Stripe's default, so the same request goes out whichever provider the
      // caller ends up on.
      const refundRequest = api.requests.filter((r) => r.path === "/v1/refunds").at(-1);
      expect(refundRequest?.form.get("payment_intent")).toBe(payment.id);
      expect(refundRequest?.form.get("amount")).toBe("2500");
    });
  });

  describe("status mapping", () => {
    const intent = (overrides: Record<string, unknown>): Record<string, unknown> => ({
      id: "pi_test_mapped",
      status: "succeeded",
      amount: 2500,
      currency: "eur",
      metadata: { reference: "order-1" },
      ...overrides,
    });

    it.each([
      ["requires_payment_method", "requires_action"],
      ["requires_confirmation", "requires_action"],
      ["requires_action", "requires_action"],
      ["requires_capture", "authorized"],
      ["processing", "processing"],
      ["canceled", "canceled"],
      ["succeeded", "succeeded"],
      ["something_stripe_added_later", "failed"],
    ])("maps intent status %s to %s", async (stripeStatus, expected) => {
      respondWith(200, intent({ status: stripeStatus }));

      await expect(buildProvider().find("pi_test_mapped")).resolves.toMatchObject({
        status: expected,
      });
    });

    it("reads the refunded total off the expanded charge, not the intent", async () => {
      respondWith(200, intent({ latest_charge: { amount_refunded: 2500 } }));

      // The intent stays `succeeded` at Stripe forever; only the charge knows.
      await expect(buildProvider().find("pi_test_mapped")).resolves.toMatchObject({
        status: "refunded",
        amountRefunded: { amountMinor: 2500, currency: "EUR" },
      });
    });

    it("reports a part-refunded charge as partially_refunded", async () => {
      respondWith(200, intent({ latest_charge: { amount_refunded: 1000 } }));

      await expect(buildProvider().find("pi_test_mapped")).resolves.toMatchObject({
        status: "partially_refunded",
      });
    });

    it("surfaces the client secret as the next action while confirmation is pending", async () => {
      respondWith(200, intent({ status: "requires_action", client_secret: "pi_test_secret" }));

      await expect(buildProvider().find("pi_test_mapped")).resolves.toMatchObject({
        nextAction: { type: "client_confirmation", clientSecret: "pi_test_secret" },
      });
    });

    it("does not attach a next action once the payment is captured", async () => {
      respondWith(200, intent({ status: "succeeded", client_secret: "pi_test_secret" }));

      await expect(buildProvider().find("pi_test_mapped")).resolves.not.toHaveProperty(
        "nextAction",
      );
    });
  });

  describe("error mapping", () => {
    it("passes a declined card through as 402, the way Stripe reports it", async () => {
      respondWith(402, {
        error: { type: "card_error", code: "card_declined", message: "Your card was declined." },
      });

      const error = await buildProvider()
        .authorize({ amount: AMOUNT, reference: "order-1" })
        .catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(PaymentProviderError);
      expect((error as PaymentProviderError).getStatus()).toBe(HttpStatus.PAYMENT_REQUIRED);
      expect((error as PaymentProviderError).upstreamCode).toBe("card_declined");
    });

    it("reports rate limiting as 503 rather than a bad gateway", async () => {
      respondWith(429, {
        error: { type: "rate_limit_error", code: "rate_limit", message: "Too many requests" },
      });

      const error = await buildProvider()
        .find("pi_test_1")
        .catch((caught: unknown) => caught);

      expect((error as PaymentProviderError).getStatus()).toBe(HttpStatus.SERVICE_UNAVAILABLE);
    });

    it("reports any other upstream failure as 502", async () => {
      respondWith(500, { error: { type: "api_error", message: "Something went wrong" } });

      const error = await buildProvider()
        .find("pi_test_1")
        .catch((caught: unknown) => caught);

      expect((error as PaymentProviderError).getStatus()).toBe(HttpStatus.BAD_GATEWAY);
      expect((error as PaymentProviderError).message).toBe("Something went wrong");
    });

    it("does not mistake a proxy's HTML error page for a payment", async () => {
      // A 200 carrying HTML is what a misconfigured egress proxy returns, and
      // parsing it as JSON would otherwise throw somewhere far less obvious.
      respondWith(200, "<html><body>502 Bad Gateway</body></html>");

      await expect(buildProvider().find("pi_test_1")).rejects.toThrow(PaymentProviderError);
    });

    it("rejects a response missing the fields a payment needs", async () => {
      respondWith(200, { id: "pi_test_1", status: "succeeded" });

      await expect(buildProvider().find("pi_test_1")).rejects.toThrow(
        /without id, status, amount or currency/,
      );
    });

    it("falls back to a generic message when the error body has none", async () => {
      respondWith(503, {});

      await expect(buildProvider().find("pi_test_1")).rejects.toThrow(
        /Stripe request failed with status 503/,
      );
    });
  });
});
