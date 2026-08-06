import { HttpStatus, Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { normaliseMoney } from "../money";
import type { Money } from "../money";
import {
  PaymentNotFoundError,
  PaymentProviderError,
  PaymentProviderNotConfiguredError,
  PaymentStateError,
} from "../payment.errors";
import { resolveRefundAmount } from "../refund-rules";
import type { CreatePaymentInput, Payment, PaymentProvider, PaymentProviderName } from "../ports";
import type { PaymentStatus } from "../ports";
import { asRecord, readNumber, readString, requestJson } from "@/common/http";

const DEFAULT_BASE_URL = "https://api.stripe.com";

const REQUIRED_ENV = ["STRIPE_SECRET_KEY"] as const;

/**
 * Stripe, over the PaymentIntents API.
 *
 * Intents are created with `capture_method=manual` so the port's
 * authorize/capture split maps onto Stripe's own two-step flow rather than
 * being simulated on top of an immediate charge.
 *
 * Every call expands `latest_charge`, because the refunded total lives on the
 * charge and not on the intent: without it `find()` would report a fully
 * refunded payment as `succeeded`.
 *
 * `Stripe-Version` is sent only when `STRIPE_API_VERSION` is set. Hard-coding a
 * default here would mean shipping a dated version string that nobody can
 * verify without an account — and a version Stripe does not recognise is a 400
 * on every request. With the header omitted, Stripe uses the version pinned to
 * the account, which is the one its dashboard and webhooks already agree on.
 * Set the variable to pin explicitly, and upgrade it deliberately.
 */
@Injectable()
export class StripePaymentProvider implements PaymentProvider {
  readonly name: PaymentProviderName = "stripe";

  private readonly secretKey: string | null;
  private readonly baseUrl: string;
  private readonly apiVersion: string | null;

  constructor(config: ConfigService) {
    this.secretKey = config.get<string>("STRIPE_SECRET_KEY") ?? null;
    this.baseUrl = (config.get<string>("STRIPE_API_BASE_URL") ?? DEFAULT_BASE_URL).replace(
      /\/+$/,
      "",
    );
    this.apiVersion = config.get<string>("STRIPE_API_VERSION") ?? null;
  }

  get isConfigured(): boolean {
    return this.secretKey !== null;
  }

  async authorize(input: CreatePaymentInput): Promise<Payment> {
    const amount = normaliseMoney(input.amount);

    const form = new URLSearchParams({
      amount: String(amount.amountMinor),
      // Stripe currency codes are lower-case; the domain keeps them upper-case.
      currency: amount.currency.toLowerCase(),
      capture_method: "manual",
      "automatic_payment_methods[enabled]": "true",
      "metadata[reference]": input.reference,
      "expand[]": "latest_charge",
    });
    if (input.description) form.set("description", input.description);
    if (input.customerEmail) form.set("receipt_email", input.customerEmail);

    const body = await this.send("POST", "/v1/payment_intents", form, {
      // Scoped to the caller's own reference, so a retry after a network
      // timeout returns the original intent instead of creating a second one.
      "Idempotency-Key": `authorize:${input.reference}`,
    });

    return this.toPayment(body);
  }

  async capture(paymentId: string): Promise<Payment> {
    const form = new URLSearchParams({ "expand[]": "latest_charge" });
    const body = await this.send(
      "POST",
      `/v1/payment_intents/${encodeURIComponent(paymentId)}/capture`,
      form,
      {},
      paymentId,
    );

    return this.toPayment(body);
  }

  async refund(paymentId: string, amount?: Money): Promise<Payment> {
    const existing = await this.find(paymentId);
    if (!existing) throw new PaymentNotFoundError(this.name, paymentId);

    const requested = resolveRefundAmount(existing, amount);

    const form = new URLSearchParams({
      payment_intent: paymentId,
      amount: String(requested.amountMinor),
    });

    // Stripe's refund object carries only the refund, not the running total on
    // the intent, so the post-refund payment is re-read rather than inferred.
    await this.send("POST", "/v1/refunds", form, {}, paymentId);

    const refreshed = await this.find(paymentId);
    if (!refreshed) throw new PaymentNotFoundError(this.name, paymentId);
    return refreshed;
  }

  async find(paymentId: string): Promise<Payment | null> {
    this.requireCredentials();

    const url = `${this.baseUrl}/v1/payment_intents/${encodeURIComponent(paymentId)}?expand[]=latest_charge`;
    const response = await requestJson(url, { method: "GET", headers: this.headers({}) });

    if (response.status === HttpStatus.NOT_FOUND) return null;
    if (!response.ok) throw this.upstreamError(response.status, response.body);

    return this.toPayment(response.body);
  }

  private requireCredentials(): string {
    if (!this.secretKey) {
      throw new PaymentProviderNotConfiguredError(this.name, REQUIRED_ENV);
    }
    return this.secretKey;
  }

  private headers(extra: Record<string, string>): Record<string, string> {
    return {
      Authorization: `Bearer ${this.requireCredentials()}`,
      ...(this.apiVersion ? { "Stripe-Version": this.apiVersion } : {}),
      ...extra,
    };
  }

  private async send(
    method: string,
    path: string,
    form: URLSearchParams,
    extraHeaders: Record<string, string>,
    /** Set when a 404 means "this payment is gone" rather than "bad route". */
    paymentId?: string,
  ): Promise<unknown> {
    this.requireCredentials();

    const response = await requestJson(`${this.baseUrl}${path}`, {
      method,
      headers: {
        ...this.headers(extraHeaders),
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: form.toString(),
    });

    if (response.ok) return response.body;

    if (response.status === HttpStatus.NOT_FOUND && paymentId) {
      throw new PaymentNotFoundError(this.name, paymentId);
    }

    const error = asRecord(asRecord(response.body)?.error);
    // Stripe answers "capture an intent that is not capturable" with a 400.
    // That is a state conflict on our side of the port, not a gateway failure,
    // and every provider has to report it the same way for the contract to hold.
    if (readString(error, "code") === "payment_intent_unexpected_state") {
      throw new PaymentStateError(
        this.name,
        readString(error, "message") ??
          `Payment ${paymentId ?? ""} is not in a state Stripe will accept for this operation`,
      );
    }

    throw this.upstreamError(response.status, response.body);
  }

  private upstreamError(status: number, body: unknown): PaymentProviderError {
    const error = asRecord(asRecord(body)?.error);
    const message = readString(error, "message") ?? `Stripe request failed with status ${status}`;
    const code = readString(error, "code") ?? readString(error, "type") ?? undefined;

    return new PaymentProviderError(this.name, message, code, mapErrorStatus(status, error));
  }

  private toPayment(body: unknown): Payment {
    const intent = asRecord(body);
    const id = readString(intent, "id");
    const rawStatus = readString(intent, "status");
    const amountMinor = readNumber(intent, "amount");
    const currency = readString(intent, "currency");

    if (!id || !rawStatus || amountMinor === null || !currency) {
      throw new PaymentProviderError(
        this.name,
        "Stripe returned a payment intent without id, status, amount or currency",
      );
    }

    const amount = normaliseMoney({ amountMinor, currency: currency.toUpperCase() });
    const charge = asRecord(intent?.latest_charge);
    const refundedMinor = readNumber(charge, "amount_refunded") ?? 0;
    const status = mapStatus(rawStatus, amount.amountMinor, refundedMinor);
    const clientSecret = readString(intent, "client_secret");

    return {
      id,
      provider: this.name,
      status,
      amount,
      amountRefunded: { amountMinor: refundedMinor, currency: amount.currency },
      reference: readString(asRecord(intent?.metadata), "reference") ?? "",
      ...(status === "requires_action" && clientSecret
        ? { nextAction: { type: "client_confirmation" as const, clientSecret } }
        : {}),
    };
  }
}

/**
 * Stripe's intent status, plus the refund total, collapsed onto the port's
 * lifecycle. `succeeded` alone is ambiguous — a fully refunded intent stays
 * `succeeded` at Stripe forever — so the refunded amount decides.
 */
function mapStatus(rawStatus: string, amountMinor: number, refundedMinor: number): PaymentStatus {
  switch (rawStatus) {
    case "requires_payment_method":
    case "requires_confirmation":
    case "requires_action":
      return "requires_action";
    case "requires_capture":
      return "authorized";
    case "processing":
      return "processing";
    case "canceled":
      return "canceled";
    case "succeeded":
      if (refundedMinor <= 0) return "succeeded";
      return refundedMinor >= amountMinor ? "refunded" : "partially_refunded";
    default:
      return "failed";
  }
}

function mapErrorStatus(status: number, error: Record<string, unknown> | null): HttpStatus {
  // A declined card is the buyer's problem, and 402 is the status Stripe itself
  // uses for it — passing it through keeps that distinction at our edge too.
  if (readString(error, "type") === "card_error") return HttpStatus.PAYMENT_REQUIRED;
  if (status === HttpStatus.TOO_MANY_REQUESTS) return HttpStatus.SERVICE_UNAVAILABLE;
  return HttpStatus.BAD_GATEWAY;
}
