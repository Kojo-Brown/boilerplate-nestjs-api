import { describePaymentProviderContract } from "./payment-provider.contract";
import { MockPaymentProvider } from "./providers/mock-payment.provider";
import { PaypalPaymentProvider } from "./providers/paypal-payment.provider";
import { StripePaymentProvider } from "./providers/stripe-payment.provider";
import { FakePaypalApi } from "@/test-utils/fake-paypal-api";
import { FakeStripeApi } from "@/test-utils/fake-stripe-api";
import { stubConfig } from "@/test-utils/stub-config";

const STRIPE_BASE_URL = "https://stripe.test";
const STRIPE_SECRET_KEY = "sk_test_fake_key_for_unit_tests";

const PAYPAL_BASE_URL = "https://paypal.test";
const PAYPAL_CLIENT_ID = "fake-paypal-client-id";
const PAYPAL_CLIENT_SECRET = "fake-paypal-client-secret";

const realFetch = global.fetch;

afterEach(() => {
  global.fetch = realFetch;
});

describePaymentProviderContract("MockPaymentProvider", () => ({
  provider: new MockPaymentProvider(),
  // Nothing to approve: the mock has no buyer in the loop.
  approve: () => undefined,
}));

describePaymentProviderContract("StripePaymentProvider", () => {
  const api = new FakeStripeApi(STRIPE_BASE_URL, STRIPE_SECRET_KEY);
  global.fetch = api.fetch;

  return {
    provider: new StripePaymentProvider(
      stubConfig({
        STRIPE_SECRET_KEY,
        STRIPE_API_BASE_URL: STRIPE_BASE_URL,
      }),
    ),
    // Stripe's approval happens client-side against the intent's client secret,
    // before the server ever sees it; the fake creates intents already
    // confirmed, so there is nothing for the harness to do here.
    approve: () => undefined,
  };
});

describePaymentProviderContract("PaypalPaymentProvider", () => {
  const api = new FakePaypalApi(PAYPAL_BASE_URL, PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET);
  global.fetch = api.fetch;

  return {
    provider: new PaypalPaymentProvider(
      stubConfig({
        PAYPAL_CLIENT_ID,
        PAYPAL_CLIENT_SECRET,
        PAYPAL_API_BASE_URL: PAYPAL_BASE_URL,
      }),
    ),
    // The buyer approving on PayPal's site. Without it the order stays CREATED
    // and PayPal answers a capture with 422/ORDER_NOT_APPROVED.
    approve: (payment) => api.approve(payment.id),
  };
});
