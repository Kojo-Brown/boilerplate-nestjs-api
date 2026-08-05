import { Injectable } from "@nestjs/common";
import { normaliseMoney } from "../money";
import type { Money } from "../money";
import { PaymentNotFoundError, PaymentStateError } from "../payment.errors";
import { resolveRefundAmount } from "../refund-rules";
import type { CreatePaymentInput, Payment, PaymentProvider, PaymentProviderName } from "../ports";

/**
 * An in-memory gateway for local development, tests, and CI.
 *
 * It is not a stub that resolves with whatever it is handed: it runs the same
 * state machine the real providers enforce, so a checkout flow that captures
 * twice or refunds more than it took fails here rather than in staging against
 * Stripe. That is the whole reason to have a mock provider instead of mocking
 * the port at each call site.
 *
 * The one deliberate difference from the real gateways is that `authorize()`
 * lands directly on `authorized` with no `nextAction` — there is no buyer to
 * redirect. Anything that depends on the approval step has to be exercised
 * against a real provider's sandbox.
 *
 * State lives on the instance, so it is bounded by the process and lost on
 * restart. That is intentional: a mock that persisted would need a migration.
 */
@Injectable()
export class MockPaymentProvider implements PaymentProvider {
  readonly name: PaymentProviderName = "mock";

  /** Always usable: there is nothing to configure. */
  readonly isConfigured = true;

  private readonly payments = new Map<string, Payment>();
  private readonly idsByReference = new Map<string, string>();
  private sequence = 0;

  async authorize(input: CreatePaymentInput): Promise<Payment> {
    const amount = normaliseMoney(input.amount);

    // Idempotency, the same guarantee the real providers give against
    // `Idempotency-Key` and `PayPal-Request-Id`: a retried authorize returns
    // the original payment rather than charging the buyer twice.
    const existingId = this.idsByReference.get(input.reference);
    if (existingId) return this.require(existingId);

    this.sequence += 1;
    const payment: Payment = {
      id: `pay_mock_${String(this.sequence).padStart(6, "0")}`,
      provider: this.name,
      status: "authorized",
      amount,
      amountRefunded: { amountMinor: 0, currency: amount.currency },
      reference: input.reference,
    };

    this.payments.set(payment.id, payment);
    this.idsByReference.set(payment.reference, payment.id);
    return payment;
  }

  async capture(paymentId: string): Promise<Payment> {
    const payment = this.require(paymentId);

    if (payment.status !== "authorized") {
      throw new PaymentStateError(
        this.name,
        `Payment ${paymentId} cannot be captured from status "${payment.status}"`,
      );
    }

    return this.store({ ...payment, status: "succeeded" });
  }

  async refund(paymentId: string, amount?: Money): Promise<Payment> {
    const payment = this.require(paymentId);
    const requested = resolveRefundAmount(payment, amount);

    const refunded = payment.amountRefunded.amountMinor + requested.amountMinor;
    return this.store({
      ...payment,
      status: refunded === payment.amount.amountMinor ? "refunded" : "partially_refunded",
      amountRefunded: { amountMinor: refunded, currency: payment.amount.currency },
    });
  }

  async find(paymentId: string): Promise<Payment | null> {
    return this.payments.get(paymentId) ?? null;
  }

  private require(paymentId: string): Payment {
    const payment = this.payments.get(paymentId);
    if (!payment) throw new PaymentNotFoundError(this.name, paymentId);
    return payment;
  }

  private store(payment: Payment): Payment {
    this.payments.set(payment.id, payment);
    return payment;
  }
}
