import { Module } from "@nestjs/common";
import { PaymentProviderFactory } from "./payment-provider.factory";
import { PAYMENT_PROVIDERS } from "./ports";
import type { PaymentProvider } from "./ports";
import { MockPaymentProvider } from "./providers/mock-payment.provider";
import { PaypalPaymentProvider } from "./providers/paypal-payment.provider";
import { StripePaymentProvider } from "./providers/stripe-payment.provider";

/**
 * The only file that knows which gateways exist.
 *
 * Registering a fourth is two lines — the class in `providers`, the class in
 * `inject` — and no consumer, and not `PaymentProviderFactory`, changes.
 */
@Module({
  providers: [
    MockPaymentProvider,
    StripePaymentProvider,
    PaypalPaymentProvider,
    {
      provide: PAYMENT_PROVIDERS,
      inject: [MockPaymentProvider, StripePaymentProvider, PaypalPaymentProvider],
      useFactory: (...providers: PaymentProvider[]): readonly PaymentProvider[] => providers,
    },
    PaymentProviderFactory,
  ],
  // Only the factory leaves the module. Exporting the concrete providers would
  // let a consumer inject Stripe directly and undo the indirection.
  exports: [PaymentProviderFactory],
})
export class PaymentsModule {}
