import { PaymentNotFoundError, PaymentStateError } from "./payment.errors";
import type { Payment, PaymentProvider } from "./ports";

/**
 * The behavioural contract every payment provider must satisfy.
 *
 * `PaymentProviderFactory` hands out a `PaymentProvider` chosen at runtime, so
 * anything downstream must work identically whichever one it gets (LSP). The
 * type system only checks the four signatures; what actually breaks a checkout
 * is behaviour — a provider that resolves with `undefined` where another
 * resolves with `null`, or that silently allows a second capture, or that
 * reports a fully refunded payment as `succeeded` because its refunded total
 * lives on a different object.
 *
 * So the contract lives here once and `payment-provider.contract.spec.ts` runs
 * it against all three implementations, the two HTTP ones driven by in-process
 * fakes of the real APIs. Adding a gateway means adding one line there.
 *
 * `approve` is the harness's chance to stand in for the buyer: PayPal will not
 * capture an order nobody approved, and pretending otherwise would shrink the
 * contract to whatever the mock happens to do.
 */
export interface PaymentProviderHarness {
  readonly provider: PaymentProvider;
  approve(payment: Payment): Promise<void> | void;
}

const AMOUNT = { amountMinor: 2500, currency: "EUR" };

export function describePaymentProviderContract(
  name: string,
  createHarness: () => PaymentProviderHarness,
): void {
  describe(`${name} (payment provider contract)`, () => {
    let harness: PaymentProviderHarness;
    let provider: PaymentProvider;
    let reference = 0;

    /** A fresh reference per call, so idempotency does not leak between tests. */
    const nextReference = (): string => `order-${(reference += 1)}`;

    const authorized = async (amount = AMOUNT): Promise<Payment> =>
      provider.authorize({ amount, reference: nextReference() });

    const captured = async (amount = AMOUNT): Promise<Payment> => {
      const payment = await authorized(amount);
      await harness.approve(payment);
      return provider.capture(payment.id);
    };

    beforeEach(() => {
      harness = createHarness();
      provider = harness.provider;
    });

    describe("authorize()", () => {
      it("echoes the amount, currency and reference back", async () => {
        const ref = nextReference();

        const payment = await provider.authorize({ amount: AMOUNT, reference: ref });

        expect(payment.amount).toEqual(AMOUNT);
        expect(payment.reference).toBe(ref);
        expect(payment.provider).toBe(provider.name);
      });

      it("reports a payment that has not taken any money yet", async () => {
        const payment = await authorized();

        expect(["requires_action", "authorized"]).toContain(payment.status);
        expect(payment.amountRefunded).toEqual({ amountMinor: 0, currency: "EUR" });
      });

      it("is idempotent on the reference", async () => {
        const ref = nextReference();

        const first = await provider.authorize({ amount: AMOUNT, reference: ref });
        const second = await provider.authorize({ amount: AMOUNT, reference: ref });

        expect(second.id).toBe(first.id);
      });
    });

    describe("find()", () => {
      it("resolves with null — not undefined — for an unknown id", async () => {
        await expect(provider.find("no-such-payment")).resolves.toBeNull();
      });

      it("resolves with the payment that was authorized", async () => {
        const payment = await authorized();

        await expect(provider.find(payment.id)).resolves.toMatchObject({
          id: payment.id,
          amount: AMOUNT,
          reference: payment.reference,
        });
      });
    });

    describe("capture()", () => {
      it("takes an approved payment to succeeded", async () => {
        const payment = await captured();

        expect(payment.status).toBe("succeeded");
        expect(payment.amount).toEqual(AMOUNT);
      });

      it("is visible to a later find()", async () => {
        const payment = await captured();

        await expect(provider.find(payment.id)).resolves.toMatchObject({ status: "succeeded" });
      });

      it("rejects a second capture", async () => {
        const payment = await captured();

        await expect(provider.capture(payment.id)).rejects.toBeInstanceOf(PaymentStateError);
      });

      it("rejects an unknown payment", async () => {
        await expect(provider.capture("no-such-payment")).rejects.toBeInstanceOf(
          PaymentNotFoundError,
        );
      });
    });

    describe("refund()", () => {
      it("refunds the full amount when none is given", async () => {
        const payment = await captured();

        const refunded = await provider.refund(payment.id);

        expect(refunded.status).toBe("refunded");
        expect(refunded.amountRefunded).toEqual(AMOUNT);
      });

      it("reports a partial refund as partially_refunded", async () => {
        const payment = await captured();

        const refunded = await provider.refund(payment.id, {
          amountMinor: 1000,
          currency: "EUR",
        });

        expect(refunded.status).toBe("partially_refunded");
        expect(refunded.amountRefunded).toEqual({ amountMinor: 1000, currency: "EUR" });
      });

      it("accumulates refunds until the payment is fully refunded", async () => {
        const payment = await captured();

        await provider.refund(payment.id, { amountMinor: 1000, currency: "EUR" });
        const refunded = await provider.refund(payment.id, { amountMinor: 1500, currency: "EUR" });

        expect(refunded.status).toBe("refunded");
        expect(refunded.amountRefunded).toEqual(AMOUNT);
      });

      it("rejects a refund larger than what is left", async () => {
        const payment = await captured();
        await provider.refund(payment.id, { amountMinor: 2000, currency: "EUR" });

        await expect(
          provider.refund(payment.id, { amountMinor: 1000, currency: "EUR" }),
        ).rejects.toBeInstanceOf(PaymentStateError);
      });

      it("rejects a refund in a different currency", async () => {
        const payment = await captured();

        await expect(
          provider.refund(payment.id, { amountMinor: 1000, currency: "USD" }),
        ).rejects.toBeInstanceOf(PaymentStateError);
      });

      it("rejects a payment that was never captured", async () => {
        const payment = await authorized();

        await expect(provider.refund(payment.id)).rejects.toBeInstanceOf(PaymentStateError);
      });

      it("rejects an unknown payment", async () => {
        await expect(provider.refund("no-such-payment")).rejects.toBeInstanceOf(
          PaymentNotFoundError,
        );
      });
    });
  });
}
