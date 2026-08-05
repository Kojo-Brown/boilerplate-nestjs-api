import { HttpStatus, Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { fromDecimalString, normaliseMoney, toDecimalString } from "../money";
import type { Money } from "../money";
import {
  PaymentNotFoundError,
  PaymentProviderError,
  PaymentProviderNotConfiguredError,
  PaymentStateError,
} from "../payment.errors";
import { resolveRefundAmount } from "../refund-rules";
import type { CreatePaymentInput, Payment, PaymentProvider, PaymentProviderName } from "../ports";
import type { PaymentNextAction, PaymentStatus } from "../ports";
import { asRecord, readArray, readString, requestJson } from "./http";

const DEFAULT_BASE_URL = "https://api-m.sandbox.paypal.com";

/** Renew this far before expiry so a token cannot lapse mid-request. */
const TOKEN_REFRESH_MARGIN_MS = 60_000;

const REQUIRED_ENV = ["PAYPAL_CLIENT_ID", "PAYPAL_CLIENT_SECRET"] as const;

interface CachedToken {
  readonly accessToken: string;
  readonly expiresAt: number;
}

/**
 * PayPal, over the Orders v2 REST API.
 *
 * There is no server SDK here on purpose: PayPal deprecated
 * `@paypal/checkout-server-sdk` and its replacement does not cover the whole
 * Orders surface, so the REST API is the stable interface.
 *
 * The shape that leaks into the port is the approval step —
 * `authorize()` returns `requires_action` with a redirect, because a PayPal
 * order cannot be captured until the buyer approves it on PayPal's own site.
 * Pretending otherwise would make the mock the only provider the port fits.
 */
@Injectable()
export class PaypalPaymentProvider implements PaymentProvider {
  readonly name: PaymentProviderName = "paypal";

  private readonly clientId: string | null;
  private readonly clientSecret: string | null;
  private readonly baseUrl: string;

  private cachedToken: CachedToken | null = null;
  /** In-flight token request, shared so concurrent calls make one round trip. */
  private tokenRequest: Promise<string> | null = null;

  constructor(config: ConfigService) {
    this.clientId = config.get<string>("PAYPAL_CLIENT_ID") ?? null;
    this.clientSecret = config.get<string>("PAYPAL_CLIENT_SECRET") ?? null;
    this.baseUrl = (config.get<string>("PAYPAL_API_BASE_URL") ?? DEFAULT_BASE_URL).replace(
      /\/+$/,
      "",
    );
  }

  get isConfigured(): boolean {
    return this.clientId !== null && this.clientSecret !== null;
  }

  async authorize(input: CreatePaymentInput): Promise<Payment> {
    const amount = normaliseMoney(input.amount);

    const purchaseUnit: Record<string, unknown> = {
      reference_id: input.reference,
      // `reference_id` is not returned on every capture webhook, `custom_id`
      // is — both carry the reference so it survives either path back.
      custom_id: input.reference,
      amount: { currency_code: amount.currency, value: toDecimalString(amount) },
      ...(input.description ? { description: input.description } : {}),
    };

    const experienceContext: Record<string, unknown> = {
      ...(input.returnUrl ? { return_url: input.returnUrl } : {}),
      ...(input.cancelUrl ? { cancel_url: input.cancelUrl } : {}),
    };

    const body = await this.send(
      "POST",
      "/v2/checkout/orders",
      {
        intent: "CAPTURE",
        purchase_units: [purchaseUnit],
        ...(Object.keys(experienceContext).length > 0
          ? { payment_source: { paypal: { experience_context: experienceContext } } }
          : {}),
        ...(input.customerEmail ? { payer: { email_address: input.customerEmail } } : {}),
      },
      // PayPal's idempotency header. Same guarantee as Stripe's, same key.
      { "PayPal-Request-Id": `authorize:${input.reference}` },
    );

    return this.toPayment(body);
  }

  async capture(paymentId: string): Promise<Payment> {
    const body = await this.send(
      "POST",
      `/v2/checkout/orders/${encodeURIComponent(paymentId)}/capture`,
      {},
      { "PayPal-Request-Id": `capture:${paymentId}` },
      paymentId,
    );

    return this.toPayment(body);
  }

  async refund(paymentId: string, amount?: Money): Promise<Payment> {
    const order = await this.findOrder(paymentId);
    if (!order) throw new PaymentNotFoundError(this.name, paymentId);

    const existing = this.toPayment(order);
    const refundAmount = resolveRefundAmount(existing, amount);

    // Refunds go against the capture, not the order — the order id alone is not
    // enough, so the capture id is read back off the order first.
    const captureId = readString(asRecord(firstCapture(order)), "id");
    if (!captureId) {
      throw new PaymentStateError(
        this.name,
        `Payment ${paymentId} has no capture to refund against`,
      );
    }

    await this.send(
      "POST",
      `/v2/payments/captures/${encodeURIComponent(captureId)}/refund`,
      {
        amount: {
          currency_code: refundAmount.currency,
          value: toDecimalString(refundAmount),
        },
      },
      {},
      paymentId,
    );

    const refreshed = await this.findOrder(paymentId);
    if (!refreshed) throw new PaymentNotFoundError(this.name, paymentId);
    return this.toPayment(refreshed);
  }

  async find(paymentId: string): Promise<Payment | null> {
    const order = await this.findOrder(paymentId);
    return order === null ? null : this.toPayment(order);
  }

  private async findOrder(paymentId: string): Promise<unknown> {
    const token = await this.accessToken();
    const response = await requestJson(
      `${this.baseUrl}/v2/checkout/orders/${encodeURIComponent(paymentId)}`,
      { method: "GET", headers: { Authorization: `Bearer ${token}` } },
    );

    if (response.status === HttpStatus.NOT_FOUND) return null;
    if (!response.ok) throw this.upstreamError(response.status, response.body);
    return response.body;
  }

  private requireCredentials(): { clientId: string; clientSecret: string } {
    if (!this.clientId || !this.clientSecret) {
      throw new PaymentProviderNotConfiguredError(this.name, REQUIRED_ENV);
    }
    return { clientId: this.clientId, clientSecret: this.clientSecret };
  }

  /**
   * Returns a cached OAuth2 token, minting one when it is missing or close to
   * expiry. Concurrent callers share the in-flight request rather than each
   * opening their own — PayPal rate-limits token issuance.
   */
  private async accessToken(): Promise<string> {
    const cached = this.cachedToken;
    if (cached && cached.expiresAt - TOKEN_REFRESH_MARGIN_MS > Date.now()) {
      return cached.accessToken;
    }
    if (this.tokenRequest) return this.tokenRequest;

    this.tokenRequest = this.mintToken().finally(() => {
      // Cleared either way: a failed mint must not be retried from cache.
      this.tokenRequest = null;
    });
    return this.tokenRequest;
  }

  private async mintToken(): Promise<string> {
    const { clientId, clientSecret } = this.requireCredentials();
    const basic = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");

    const response = await requestJson(`${this.baseUrl}/v1/oauth2/token`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${basic}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: "grant_type=client_credentials",
    });

    if (!response.ok) throw this.upstreamError(response.status, response.body);

    const body = asRecord(response.body);
    const accessToken = readString(body, "access_token");
    const expiresIn = body?.expires_in;
    if (!accessToken) {
      throw new PaymentProviderError(this.name, "PayPal returned no access token");
    }

    const ttlSeconds = typeof expiresIn === "number" && expiresIn > 0 ? expiresIn : 300;
    this.cachedToken = { accessToken, expiresAt: Date.now() + ttlSeconds * 1000 };
    return accessToken;
  }

  private async send(
    method: string,
    path: string,
    body: Record<string, unknown>,
    extraHeaders: Record<string, string>,
    /** Set when a 404 means "this order is gone" rather than "bad route". */
    paymentId?: string,
  ): Promise<unknown> {
    const token = await this.accessToken();

    const response = await requestJson(`${this.baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        ...extraHeaders,
      },
      body: JSON.stringify(body),
    });

    if (response.ok) return response.body;

    if (response.status === HttpStatus.NOT_FOUND && paymentId) {
      throw new PaymentNotFoundError(this.name, paymentId);
    }

    const issue = firstIssue(response.body);
    // PayPal answers "capture an unapproved order" with a 422, which is a state
    // conflict on our side of the port, not a gateway failure.
    if (issue === "ORDER_NOT_APPROVED" || issue === "ORDER_ALREADY_CAPTURED") {
      throw new PaymentStateError(
        this.name,
        `PayPal rejected the request on ${paymentId ?? path}: ${issue}`,
      );
    }

    throw this.upstreamError(response.status, response.body);
  }

  private upstreamError(status: number, body: unknown): PaymentProviderError {
    const record = asRecord(body);
    const issue = firstIssue(body);
    const message =
      readString(record, "message") ??
      readString(record, "error_description") ??
      `PayPal request failed with status ${status}`;
    const code = issue ?? readString(record, "name") ?? readString(record, "error") ?? undefined;

    return new PaymentProviderError(
      this.name,
      message,
      code,
      status === HttpStatus.TOO_MANY_REQUESTS
        ? HttpStatus.SERVICE_UNAVAILABLE
        : HttpStatus.BAD_GATEWAY,
    );
  }

  private toPayment(body: unknown): Payment {
    const order = asRecord(body);
    const id = readString(order, "id");
    const orderStatus = readString(order, "status");
    const unit = asRecord(readArray(order, "purchase_units")[0]);
    const amountRecord = asRecord(unit?.amount);
    const currency = readString(amountRecord, "currency_code");
    const value = readString(amountRecord, "value");

    if (!id || !orderStatus || !currency || !value) {
      throw new PaymentProviderError(
        this.name,
        "PayPal returned an order without id, status or purchase amount",
      );
    }

    const amount = fromDecimalString(value, currency);
    const refundedMinor = sumRefunds(order, currency);
    const capture = asRecord(firstCapture(order));
    const status = mapStatus(
      orderStatus,
      readString(capture, "status"),
      amount.amountMinor,
      refundedMinor,
    );
    const nextAction = status === "requires_action" ? approvalAction(order) : undefined;

    return {
      id,
      provider: this.name,
      status,
      amount,
      amountRefunded: { amountMinor: refundedMinor, currency: amount.currency },
      reference: readString(unit, "reference_id") ?? readString(unit, "custom_id") ?? "",
      ...(nextAction ? { nextAction } : {}),
    };
  }
}

function payments(order: Record<string, unknown> | null): Record<string, unknown> | null {
  return asRecord(asRecord(readArray(order, "purchase_units")[0])?.payments);
}

function firstCapture(order: unknown): unknown {
  return readArray(payments(asRecord(order)), "captures")[0] ?? null;
}

/**
 * Sums the refunds recorded against the order.
 *
 * Refunds that PayPal marks `CANCELLED` or `FAILED` never moved money and are
 * excluded, or a failed refund would leave the payment looking refunded.
 */
function sumRefunds(order: Record<string, unknown> | null, currency: string): number {
  return readArray(payments(order), "refunds").reduce<number>((total, entry) => {
    const refund = asRecord(entry);
    const status = readString(refund, "status");
    if (status === "CANCELLED" || status === "FAILED") return total;

    const amount = asRecord(refund?.amount);
    const value = readString(amount, "value");
    if (!value) return total;

    return (
      total + fromDecimalString(value, readString(amount, "currency_code") ?? currency).amountMinor
    );
  }, 0);
}

function approvalAction(order: Record<string, unknown> | null): PaymentNextAction | undefined {
  const link = readArray(order, "links")
    .map((entry) => asRecord(entry))
    // `payer-action` is what the v2 API returns for a `payment_source` order;
    // `approve` is the older rel and still comes back for some flows.
    .find((entry) => {
      const rel = readString(entry, "rel");
      return rel === "payer-action" || rel === "approve";
    });

  const url = readString(link ?? null, "href");
  return url ? { type: "redirect", url } : undefined;
}

function firstIssue(body: unknown): string | undefined {
  const details = readArray(asRecord(body), "details");
  return readString(asRecord(details[0]), "issue") ?? undefined;
}

/**
 * PayPal reports state in two places — the order and its capture — and the
 * order stays `COMPLETED` after a refund, so the refunded total decides the
 * tail end of the lifecycle just as it does for Stripe.
 */
function mapStatus(
  orderStatus: string,
  captureStatus: string | null,
  amountMinor: number,
  refundedMinor: number,
): PaymentStatus {
  switch (orderStatus) {
    case "CREATED":
    case "SAVED":
    case "PAYER_ACTION_REQUIRED":
      return "requires_action";
    case "APPROVED":
      return "authorized";
    case "VOIDED":
      return "canceled";
    case "COMPLETED":
      break;
    default:
      return "failed";
  }

  if (captureStatus === "DECLINED" || captureStatus === "FAILED") return "failed";
  if (captureStatus === "PENDING") return "processing";

  if (refundedMinor <= 0) return "succeeded";
  return refundedMinor >= amountMinor ? "refunded" : "partially_refunded";
}
