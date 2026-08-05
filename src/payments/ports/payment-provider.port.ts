import type { Money } from "../money";

/**
 * Every provider the factory can resolve.
 *
 * Declared here rather than in `config/env.schema.ts` so the domain owns its
 * own vocabulary and the config layer imports it, not the other way round —
 * adding a provider is then a change in `src/payments` that the env schema
 * picks up for free.
 */
export const PAYMENT_PROVIDER_NAMES = ["stripe", "paypal", "mock"] as const;

export type PaymentProviderName = (typeof PAYMENT_PROVIDER_NAMES)[number];

export function isPaymentProviderName(value: string): value is PaymentProviderName {
  return (PAYMENT_PROVIDER_NAMES as readonly string[]).includes(value);
}

/**
 * The provider-independent lifecycle.
 *
 * Deliberately smaller than any one provider's own status set: `authorized` is
 * Stripe's `requires_capture` and PayPal's `APPROVED`, `succeeded` is Stripe's
 * `succeeded` and PayPal's `COMPLETED`. Callers branch on these six and never
 * on a provider's raw string, which is what makes the providers substitutable.
 */
export type PaymentStatus =
  /** Created, but the buyer still has to approve it — see `nextAction`. */
  | "requires_action"
  /** Approved by the buyer and ready for `capture()`. */
  | "authorized"
  /** Capture is settling asynchronously; nothing for the caller to do but wait. */
  | "processing"
  /** Money captured. */
  | "succeeded"
  | "partially_refunded"
  | "refunded"
  | "canceled"
  | "failed";

/**
 * What the caller must do before a payment can be captured.
 *
 * Both real providers need the buyer in the loop before money moves — PayPal
 * with a redirect to its approval page, Stripe with a client-side confirmation
 * against the intent's client secret. Modelling that here, rather than
 * pretending a server-to-server `authorize()` is enough, is the difference
 * between an interface that fits both providers and one that only fits the
 * mock.
 */
export type PaymentNextAction =
  | { readonly type: "redirect"; readonly url: string }
  | { readonly type: "client_confirmation"; readonly clientSecret: string };

export interface Payment {
  /** Provider-side identifier. Opaque; only meaningful to the issuing provider. */
  readonly id: string;
  readonly provider: PaymentProviderName;
  readonly status: PaymentStatus;
  readonly amount: Money;
  /** How much of `amount` has been refunded. Zero for a payment never refunded. */
  readonly amountRefunded: Money;
  /** The caller's own identifier — an order id — echoed back by the provider. */
  readonly reference: string;
  readonly nextAction?: PaymentNextAction;
}

export interface CreatePaymentInput {
  readonly amount: Money;
  /**
   * The caller's identifier for whatever is being paid for.
   *
   * Doubles as the idempotency key: replaying `authorize()` with the same
   * reference must not create a second payment, which is what makes a retry
   * after a timeout safe.
   */
  readonly reference: string;
  readonly description?: string;
  readonly customerEmail?: string;
  /**
   * Where the buyer returns after approving. Required by redirect-based
   * providers (PayPal); ignored by the others.
   */
  readonly returnUrl?: string;
  readonly cancelUrl?: string;
}

/**
 * A payment gateway, as the rest of the application sees one.
 *
 * The interface is what `PaymentProviderFactory` hands out; no consumer ever
 * names `StripePaymentProvider` or its SDK. That inversion is the point of the
 * factory: swapping gateways is an env var, and testing a checkout flow is the
 * mock rather than a network stub.
 */
export interface PaymentProvider {
  readonly name: PaymentProviderName;

  /**
   * Whether the credentials this provider needs are present.
   *
   * Nest instantiates every provider eagerly, so an unconfigured Stripe must
   * construct cleanly and refuse work later — exactly how `StorageService`
   * handles a missing bucket. The factory checks this before handing one out.
   */
  readonly isConfigured: boolean;

  /** Creates a payment. Idempotent on `reference`. */
  authorize(input: CreatePaymentInput): Promise<Payment>;

  /** Captures an authorized payment. Rejects unless the payment is `authorized`. */
  capture(paymentId: string): Promise<Payment>;

  /**
   * Refunds a captured payment, fully when `amount` is omitted.
   * Rejects if the payment is not captured or the amount exceeds what is left.
   */
  refund(paymentId: string, amount?: Money): Promise<Payment>;

  /** Resolves with `null` — never `undefined` — for an unknown id. */
  find(paymentId: string): Promise<Payment | null>;
}

/**
 * DI token for the array of every registered {@link PaymentProvider}.
 *
 * The factory injects the collection instead of the three concrete classes, so
 * it holds no reference to any implementation and registering a fourth gateway
 * touches `payments.module.ts` alone (OCP).
 */
export const PAYMENT_PROVIDERS = Symbol("PAYMENT_PROVIDERS");
