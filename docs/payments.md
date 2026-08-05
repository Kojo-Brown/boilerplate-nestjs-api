# Payments — the provider factory

`src/payments` exists to answer one question at runtime: _which gateway takes
this payment?_ Everything else in the module is what it takes to make that
answer safe to change.

## The shape

```
src/payments/
├── ports/payment-provider.port.ts   # PaymentProvider + PAYMENT_PROVIDERS token
├── payment-provider.factory.ts      # resolves a provider by name, from config
├── payments.module.ts               # the only file that names an implementation
├── money.ts                         # minor-unit arithmetic, no floats
├── refund-rules.ts                  # the refund preconditions every provider shares
├── payment.errors.ts                # HttpExceptions, so AllExceptionsFilter renders them
├── payment-provider.contract.ts     # the behavioural contract, run against all three
└── providers/
    ├── mock-payment.provider.ts     # in-memory, for local dev and CI
    ├── stripe-payment.provider.ts   # Stripe PaymentIntents, manual capture
    └── paypal-payment.provider.ts   # PayPal Orders v2
```

## Using it

Inject the factory, not a gateway:

```ts
@Injectable()
export class CheckoutService {
  constructor(private readonly payments: PaymentProviderFactory) {}

  async startCheckout(order: Order, preferredProvider?: string) {
    // `resolve()` with no argument gives the PAYMENTS_PROVIDER default;
    // with one it gives that gateway, or throws 400/503 saying why not.
    const provider = this.payments.resolve(preferredProvider);

    const payment = await provider.authorize({
      amount: { amountMinor: order.totalMinor, currency: order.currency },
      reference: order.id,
      returnUrl: `https://shop.example/orders/${order.id}/return`,
      cancelUrl: `https://shop.example/orders/${order.id}`,
    });

    // Both real gateways need the buyer before money moves.
    if (payment.status === "requires_action") return payment.nextAction;

    return provider.capture(payment.id);
  }
}
```

`PaymentsModule` exports the factory and nothing else. The concrete providers
and the `PAYMENT_PROVIDERS` collection stay internal, so no consumer can inject
`StripePaymentProvider` and quietly undo the indirection.

## Configuration

| Variable               | Default                            | Notes                                    |
| ---------------------- | ---------------------------------- | ---------------------------------------- |
| `PAYMENTS_PROVIDER`    | `mock`                             | `stripe` \| `paypal` \| `mock`           |
| `STRIPE_SECRET_KEY`    | —                                  | Required when `PAYMENTS_PROVIDER=stripe` |
| `STRIPE_API_BASE_URL`  | `https://api.stripe.com`           | Overridden in tests                      |
| `STRIPE_API_VERSION`   | —                                  | Unset: Stripe uses the account's version |
| `PAYPAL_CLIENT_ID`     | —                                  | Required when `PAYMENTS_PROVIDER=paypal` |
| `PAYPAL_CLIENT_SECRET` | —                                  | Required when `PAYMENTS_PROVIDER=paypal` |
| `PAYPAL_API_BASE_URL`  | `https://api-m.sandbox.paypal.com` | Live is `https://api-m.paypal.com`       |

Selecting a gateway without its credentials is a boot failure, not a runtime
one: `env.schema.ts` refines the selected provider's variables, so the
deployment that would have failed at the first checkout fails at startup with
the missing variable named. A gateway that is merely _registered_ need not be
configured — running on Stripe with PayPal left blank is normal, and the
factory answers a request for the blank one with 503 and the variables to set.

## Why a factory and not a `useFactory` binding

Nest can bind one provider at boot:

```ts
{ provide: PAYMENT_PROVIDER, useFactory: (c: ConfigService) => pick(c), inject: [ConfigService] }
```

That covers "the whole deployment uses Stripe" and nothing else. It cannot
express a per-request, per-tenant, or per-customer choice, and switching gateway
becomes a redeploy. `PaymentProviderFactory.resolve(name)` keeps the decision at
call time, which is where the information actually is.

The factory is built from the injected `PAYMENT_PROVIDERS` array rather than
from the three classes, so it names no implementation. Registering a fourth
gateway is two lines in `payments.module.ts`; the factory, the port, and every
consumer are untouched.

## The lifecycle, and why it is not each gateway's own

`PaymentStatus` has seven values and none of them are Stripe's or PayPal's:

| Domain               | Stripe                                       | PayPal                             |
| -------------------- | -------------------------------------------- | ---------------------------------- |
| `requires_action`    | `requires_payment_method`, `requires_action` | `CREATED`, `PAYER_ACTION_REQUIRED` |
| `authorized`         | `requires_capture`                           | `APPROVED`                         |
| `processing`         | `processing`                                 | capture `PENDING`                  |
| `succeeded`          | `succeeded`                                  | `COMPLETED` + capture `COMPLETED`  |
| `partially_refunded` | `succeeded` + partial charge refund          | `COMPLETED` + partial refunds      |
| `refunded`           | `succeeded` + full charge refund             | `COMPLETED` + full refunds         |
| `canceled`           | `canceled`                                   | `VOIDED`                           |

Two of those rows are the reason the mapping cannot be a lookup table. Neither
gateway moves off its terminal status when money is refunded — a fully refunded
Stripe intent stays `succeeded` forever, and the refunded total lives on the
_charge_, which is why every Stripe call here expands `latest_charge`. PayPal
keeps its refunds on the purchase unit's `payments.refunds`, and refunds it
marks `FAILED` or `CANCELLED` have to be excluded or a failed refund makes the
payment look settled.

The one gateway shape that does leak into the port is buyer approval:
`authorize()` may return `requires_action` with a `nextAction`, because a PayPal
order cannot be captured until the buyer approves it. Hiding that would produce
a port that only the mock can implement.

## Money

Amounts are minor units (integers) everywhere, and `money.ts` is the only place
that converts. PayPal's `value` is a decimal string, so the conversion is string
arithmetic rather than `× 100`: `Number("1.005") * 100` is `100.49999999999999`,
and JPY has no minor unit at all, so `2350 JPY` must be sent as `"2350"` and
`"2350.00"` is rejected outright.

## Testing

`payment-provider.contract.ts` holds the behavioural contract and
`payment-provider.contract.spec.ts` runs it against all three implementations —
the two HTTP ones driven by `FakeStripeApi` and `FakePaypalApi`, in-process
stand-ins that keep real state. A capture has to follow an authorize, a refund
is bounded by what was captured, and an unapproved PayPal order gets PayPal's
own 422 back.

That is what forces the providers to agree on more than their signatures. It is
also why `refund-rules.ts` exists: the three gateways report a bad refund three
different ways (`amount_too_large`, `REFUND_AMOUNT_EXCEEDED`, and nothing at
all), so the preconditions are checked locally and every provider fails the same
way.

For a checkout flow of your own, set `PAYMENTS_PROVIDER=mock` and use the real
module. `MockPaymentProvider` runs the same state machine, so a double capture
fails in your tests rather than in staging.

## Not included

No HTTP surface. There is no payments controller, DTO, or route — this module
is the gateway abstraction, and the checkout endpoints that use it belong to
whatever domain does the selling. No webhook handling either: signature
verification and event replay are a separate concern from taking a payment, and
neither gateway's webhook contract is settled by this port.
