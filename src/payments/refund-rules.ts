import { normaliseMoney, sameCurrency } from "./money";
import type { Money } from "./money";
import { PaymentStateError } from "./payment.errors";
import type { Payment } from "./ports";

/**
 * The rules every provider applies before it will attempt a refund.
 *
 * They live here rather than in each adapter for two reasons. The obvious one
 * is that three copies drift. The one that matters more is that the gateways
 * disagree about how they report a bad refund — Stripe answers a 400 with
 * `amount_too_large`, PayPal a 422 with `REFUND_AMOUNT_EXCEEDED`, the mock
 * nothing at all — so checking locally is what makes the same mistake produce
 * the same error from every provider, which is the whole point of the contract
 * suite. It also saves a round trip that was never going to succeed.
 *
 * Returns the amount to refund: the caller's, normalised, or the full
 * outstanding balance when none was given.
 */
export function resolveRefundAmount(payment: Payment, amount?: Money): Money {
  if (payment.status !== "succeeded" && payment.status !== "partially_refunded") {
    throw new PaymentStateError(
      payment.provider,
      `Payment ${payment.id} cannot be refunded from status "${payment.status}"`,
    );
  }

  const remaining = payment.amount.amountMinor - payment.amountRefunded.amountMinor;
  const requested = amount
    ? normaliseMoney(amount)
    : { amountMinor: remaining, currency: payment.amount.currency };

  if (!sameCurrency(requested, payment.amount)) {
    throw new PaymentStateError(
      payment.provider,
      `Cannot refund ${requested.currency} against a ${payment.amount.currency} payment`,
    );
  }
  if (requested.amountMinor === 0) {
    throw new PaymentStateError(payment.provider, "Refund amount must be positive");
  }
  if (requested.amountMinor > remaining) {
    throw new PaymentStateError(
      payment.provider,
      `Refund of ${requested.amountMinor} exceeds the ${remaining} still refundable on ${payment.id}`,
    );
  }

  return requested;
}
