import { HttpStatus } from "@nestjs/common";
import {
  PaymentProviderError,
  PaymentProviderNotConfiguredError,
  PaymentStateError,
} from "../payment.errors";
import { PaypalPaymentProvider } from "./paypal-payment.provider";
import { FakePaypalApi } from "@/test-utils/fake-paypal-api";
import type { FakePaypalRequest } from "@/test-utils/fake-paypal-api";
import { stubConfig } from "@/test-utils/stub-config";

const BASE_URL = "https://paypal.test";
const CLIENT_ID = "fake-paypal-client-id";
const CLIENT_SECRET = "fake-paypal-client-secret";

const AMOUNT = { amountMinor: 2500, currency: "EUR" };

const realFetch = global.fetch;

function buildProvider(env: Record<string, string | undefined> = {}): PaypalPaymentProvider {
  return new PaypalPaymentProvider(
    stubConfig({
      PAYPAL_CLIENT_ID: CLIENT_ID,
      PAYPAL_CLIENT_SECRET: CLIENT_SECRET,
      PAYPAL_API_BASE_URL: BASE_URL,
      ...env,
    }),
  );
}

/** Reads the first purchase unit off a recorded request, or fails loudly. */
function purchaseUnit(request: FakePaypalRequest | undefined): Record<string, unknown> {
  const body = request?.body as { purchase_units?: Record<string, unknown>[] } | undefined;
  const unit = body?.purchase_units?.[0];
  if (!unit) throw new Error("The recorded request carried no purchase unit");
  return unit;
}

function respondWith(status: number, body: unknown): void {
  global.fetch = jest.fn(async (_input: unknown, init?: RequestInit) => {
    // The token call has to keep working, or every test would fail on auth
    // instead of on the case it is actually about.
    if (typeof init?.body === "string" && init.body.includes("grant_type=client_credentials")) {
      return new Response(
        JSON.stringify({ access_token: "mock-paypal-access-token", expires_in: 3600 }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return new Response(typeof body === "string" ? body : JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
}

describe("PaypalPaymentProvider", () => {
  let api: FakePaypalApi;

  beforeEach(() => {
    api = new FakePaypalApi(BASE_URL, CLIENT_ID, CLIENT_SECRET);
    global.fetch = api.fetch;
  });

  afterEach(() => {
    global.fetch = realFetch;
  });

  describe("when the client credentials are absent", () => {
    it("constructs, reports itself unconfigured, and refuses every call", async () => {
      const provider = new PaypalPaymentProvider(stubConfig({ PAYPAL_CLIENT_ID: CLIENT_ID }));

      expect(provider.isConfigured).toBe(false);
      await expect(provider.authorize({ amount: AMOUNT, reference: "order-1" })).rejects.toThrow(
        PaymentProviderNotConfiguredError,
      );
      await expect(provider.find("ORDER-1")).rejects.toThrow(PaymentProviderNotConfiguredError);
    });
  });

  describe("authorize()", () => {
    it("creates a CAPTURE-intent order carrying the reference twice", async () => {
      await buildProvider().authorize({ amount: AMOUNT, reference: "order-1" });

      const request = api.requests.at(-1);
      const body = request?.body as Record<string, unknown>;
      const unit = purchaseUnit(request);

      expect(request?.path).toBe("/v2/checkout/orders");
      expect(body.intent).toBe("CAPTURE");
      expect(unit.reference_id).toBe("order-1");
      // `custom_id` too: it is the only one that survives every webhook.
      expect(unit.custom_id).toBe("order-1");
      expect(unit.amount).toEqual({ currency_code: "EUR", value: "25.00" });
      expect(request?.headers["paypal-request-id"]).toBe("authorize:order-1");
    });

    it("sends a zero-decimal currency without a fraction", async () => {
      await buildProvider().authorize({
        amount: { amountMinor: 2350, currency: "JPY" },
        reference: "order-jpy",
      });

      const unit = purchaseUnit(api.requests.at(-1));

      // "2350.00" is rejected by PayPal for JPY.
      expect(unit.amount).toEqual({ currency_code: "JPY", value: "2350" });
    });

    it("reads a zero-decimal amount back as whole units", async () => {
      const provider = buildProvider();
      const payment = await provider.authorize({
        amount: { amountMinor: 2350, currency: "JPY" },
        reference: "order-jpy",
      });

      await expect(provider.find(payment.id)).resolves.toMatchObject({
        amount: { amountMinor: 2350, currency: "JPY" },
      });
    });

    it("sends the buyer's return and cancel URLs as experience context", async () => {
      await buildProvider().authorize({
        amount: AMOUNT,
        reference: "order-1",
        returnUrl: "https://shop.test/return",
        cancelUrl: "https://shop.test/cancel",
      });

      const body = api.requests.at(-1)?.body as Record<string, unknown>;
      const source = body.payment_source as { paypal?: Record<string, unknown> };

      expect(source.paypal?.experience_context).toEqual({
        return_url: "https://shop.test/return",
        cancel_url: "https://shop.test/cancel",
      });
    });

    it("omits payment_source entirely when no URLs are given", async () => {
      await buildProvider().authorize({ amount: AMOUNT, reference: "order-1" });

      const body = api.requests.at(-1)?.body as Record<string, unknown>;
      expect(body).not.toHaveProperty("payment_source");
    });

    it("returns the approval redirect as the next action", async () => {
      const payment = await buildProvider().authorize({ amount: AMOUNT, reference: "order-1" });

      // Nothing can be captured until the buyer follows this.
      expect(payment.status).toBe("requires_action");
      expect(payment.nextAction).toEqual({
        type: "redirect",
        url: `https://paypal.test/checkoutnow?token=${payment.id}`,
      });
    });
  });

  describe("capture()", () => {
    it("rejects an order the buyer has not approved as a state conflict", async () => {
      const provider = buildProvider();
      const payment = await provider.authorize({ amount: AMOUNT, reference: "order-1" });

      // PayPal answers this with a 422; a 502 would be wrong — nothing is
      // broken, the order is simply not ready.
      const error = await provider.capture(payment.id).catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(PaymentStateError);
      expect((error as PaymentStateError).getStatus()).toBe(HttpStatus.CONFLICT);
      expect((error as PaymentStateError).message).toMatch(/ORDER_NOT_APPROVED/);
    });
  });

  describe("access token", () => {
    it("mints one token and reuses it across calls", async () => {
      const provider = buildProvider();

      await provider.authorize({ amount: AMOUNT, reference: "order-1" });
      await provider.authorize({ amount: AMOUNT, reference: "order-2" });
      await provider.find("ORDER-TEST-0001");

      expect(api.tokenMints).toBe(1);
    });

    it("shares one in-flight request between concurrent callers", async () => {
      const provider = buildProvider();

      await Promise.all([
        provider.authorize({ amount: AMOUNT, reference: "order-1" }),
        provider.authorize({ amount: AMOUNT, reference: "order-2" }),
        provider.authorize({ amount: AMOUNT, reference: "order-3" }),
      ]);

      // Three parallel checkouts on a cold provider must not open three token
      // requests — PayPal rate-limits token issuance.
      expect(api.tokenMints).toBe(1);
    });

    it("renews a token that is inside the refresh margin", async () => {
      api.tokenTtlSeconds = 30;
      const provider = buildProvider();

      await provider.authorize({ amount: AMOUNT, reference: "order-1" });
      await provider.authorize({ amount: AMOUNT, reference: "order-2" });

      // A token expiring in 30s is already inside the 60s margin, so it is
      // never reused: better a second round trip than a 401 mid-checkout.
      expect(api.tokenMints).toBe(2);
    });

    it("surfaces a credentials rejection rather than caching the failure", async () => {
      const provider = buildProvider({ PAYPAL_CLIENT_SECRET: "wrong-secret" });

      await expect(provider.find("ORDER-TEST-0001")).rejects.toThrow(PaymentProviderError);
      await expect(provider.find("ORDER-TEST-0001")).rejects.toThrow(
        /Client Authentication failed/,
      );
    });
  });

  describe("refunds", () => {
    it("refunds against the capture id, not the order id", async () => {
      const provider = buildProvider();
      const payment = await provider.authorize({ amount: AMOUNT, reference: "order-1" });
      api.approve(payment.id);
      await provider.capture(payment.id);

      await provider.refund(payment.id, { amountMinor: 1000, currency: "EUR" });

      const request = api.requests.at(-2);
      expect(request?.path).toBe(`/v2/payments/captures/CAPTURE-${payment.id}/refund`);
      expect(request?.body).toEqual({ amount: { currency_code: "EUR", value: "10.00" } });
    });

    it("ignores refunds PayPal marks as failed when totalling", async () => {
      respondWith(200, {
        id: "ORDER-TEST-0001",
        status: "COMPLETED",
        purchase_units: [
          {
            reference_id: "order-1",
            amount: { currency_code: "EUR", value: "25.00" },
            payments: {
              captures: [{ id: "CAPTURE-1", status: "COMPLETED" }],
              refunds: [
                { id: "R1", status: "COMPLETED", amount: { currency_code: "EUR", value: "10.00" } },
                { id: "R2", status: "FAILED", amount: { currency_code: "EUR", value: "15.00" } },
                { id: "R3", status: "CANCELLED", amount: { currency_code: "EUR", value: "5.00" } },
              ],
            },
          },
        ],
      });

      // Counting the failed and cancelled ones would report this payment as
      // fully refunded and quietly block a real refund of the other 15.00.
      await expect(buildProvider().find("ORDER-TEST-0001")).resolves.toMatchObject({
        status: "partially_refunded",
        amountRefunded: { amountMinor: 1000, currency: "EUR" },
      });
    });
  });

  describe("status mapping", () => {
    const order = (status: string, captureStatus?: string): Record<string, unknown> => ({
      id: "ORDER-TEST-0001",
      status,
      purchase_units: [
        {
          reference_id: "order-1",
          amount: { currency_code: "EUR", value: "25.00" },
          ...(captureStatus
            ? { payments: { captures: [{ id: "CAPTURE-1", status: captureStatus }] } }
            : {}),
        },
      ],
    });

    it.each([
      ["CREATED", undefined, "requires_action"],
      ["SAVED", undefined, "requires_action"],
      ["PAYER_ACTION_REQUIRED", undefined, "requires_action"],
      ["APPROVED", undefined, "authorized"],
      ["VOIDED", undefined, "canceled"],
      ["COMPLETED", "COMPLETED", "succeeded"],
      ["COMPLETED", "PENDING", "processing"],
      ["COMPLETED", "DECLINED", "failed"],
      ["COMPLETED", "FAILED", "failed"],
      ["SOMETHING_NEW", undefined, "failed"],
    ])("maps order %s / capture %s to %s", async (orderStatus, captureStatus, expected) => {
      respondWith(200, order(orderStatus, captureStatus));

      await expect(buildProvider().find("ORDER-TEST-0001")).resolves.toMatchObject({
        status: expected,
      });
    });

    it("falls back to custom_id when the order carries no reference_id", async () => {
      respondWith(200, {
        id: "ORDER-TEST-0001",
        status: "APPROVED",
        purchase_units: [{ custom_id: "order-7", amount: { currency_code: "EUR", value: "1.00" } }],
      });

      await expect(buildProvider().find("ORDER-TEST-0001")).resolves.toMatchObject({
        reference: "order-7",
      });
    });
  });

  describe("error mapping", () => {
    it("rejects a response missing the fields a payment needs", async () => {
      respondWith(200, { id: "ORDER-TEST-0001", status: "COMPLETED" });

      await expect(buildProvider().find("ORDER-TEST-0001")).rejects.toThrow(
        /without id, status or purchase amount/,
      );
    });

    it("reports rate limiting as 503 rather than a bad gateway", async () => {
      respondWith(429, { name: "RATE_LIMIT_REACHED", message: "Too many requests" });

      const error = await buildProvider()
        .find("ORDER-TEST-0001")
        .catch((caught: unknown) => caught);

      expect((error as PaymentProviderError).getStatus()).toBe(HttpStatus.SERVICE_UNAVAILABLE);
      expect((error as PaymentProviderError).upstreamCode).toBe("RATE_LIMIT_REACHED");
    });

    it("prefers the issue code from the details array", async () => {
      respondWith(422, {
        name: "UNPROCESSABLE_ENTITY",
        message: "The requested action could not be performed.",
        details: [{ issue: "CURRENCY_NOT_SUPPORTED" }],
      });

      const error = await buildProvider()
        .find("ORDER-TEST-0001")
        .catch((caught: unknown) => caught);

      expect((error as PaymentProviderError).upstreamCode).toBe("CURRENCY_NOT_SUPPORTED");
    });
  });
});
