import { Module } from "@nestjs/common";
import { ResilientHttpModule } from "@/common/http";
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
  // Both real gateways are `fetch` clients, and every call they make goes
  // through the breaker and ladder this module provides. Imported rather than
  // global so that a module talking to the outside world says so in its own
  // file.
  imports: [ResilientHttpModule],
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
