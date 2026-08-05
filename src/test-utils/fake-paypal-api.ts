/**
 * An in-process stand-in for the PayPal Orders v2 API.
 *
 * Same purpose as {@link "./fake-stripe-api".FakeStripeApi}: give
 * `PaypalPaymentProvider` real state to work against so it can be held to the
 * shared provider contract rather than to a mock that agrees with it by
 * construction.
 *
 * It models the buyer approval step honestly — an order is `CREATED` until
 * {@link approve} is called, and capturing before that returns PayPal's own
 * 422/`ORDER_NOT_APPROVED`, which is the single largest behavioural difference
 * between this gateway and Stripe.
 */

interface FakeCapture {
  id: string;
  status: string;
}

interface FakeRefund {
  id: string;
  status: string;
  value: string;
  currency: string;
}

interface FakeOrder {
  id: string;
  status: string;
  reference: string;
  currency: string;
  value: string;
  captures: FakeCapture[];
  refunds: FakeRefund[];
}

export interface FakePaypalRequest {
  readonly method: string;
  readonly path: string;
  readonly headers: Record<string, string>;
  readonly body: unknown;
}

const ACCESS_TOKEN = "mock-paypal-access-token";

export class FakePaypalApi {
  private readonly orders = new Map<string, FakeOrder>();
  private readonly idempotency = new Map<string, string>();
  private readonly capturesToOrder = new Map<string, string>();
  private sequence = 0;

  readonly requests: FakePaypalRequest[] = [];

  /** How many OAuth2 tokens have been minted — the token cache is asserted on it. */
  tokenMints = 0;

  /** Seconds the issued token is valid for; lowered in tests to force a renew. */
  tokenTtlSeconds = 3600;

  constructor(
    private readonly baseUrl: string,
    private readonly clientId: string,
    private readonly clientSecret: string,
  ) {}

  readonly fetch: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input.toString());
    const method = init?.method ?? "GET";
    const headers = normaliseHeaders(init?.headers);
    const rawBody = typeof init?.body === "string" ? init.body : "";

    if (!url.toString().startsWith(this.baseUrl)) {
      throw new Error(`FakePaypalApi received a request for an unexpected host: ${url.toString()}`);
    }

    const path = url.pathname;
    const parsedBody =
      path === "/v1/oauth2/token" ? rawBody : rawBody.length > 0 ? JSON.parse(rawBody) : {};
    this.requests.push({ method, path, headers, body: parsedBody });

    if (path === "/v1/oauth2/token") return this.mintToken(headers);

    if (headers.authorization !== `Bearer ${ACCESS_TOKEN}`) {
      return json(401, { error: "invalid_token", error_description: "Access token is invalid" });
    }

    return this.route(method, path, asRecord(parsedBody), headers);
  };

  /** The buyer approving the order on PayPal's site. */
  approve(orderId: string): void {
    const order = this.orders.get(orderId);
    if (!order) throw new Error(`FakePaypalApi: cannot approve unknown order ${orderId}`);
    order.status = "APPROVED";
  }

  private mintToken(headers: Record<string, string>): Response {
    const expected = `Basic ${Buffer.from(`${this.clientId}:${this.clientSecret}`).toString("base64")}`;
    if (headers.authorization !== expected) {
      return json(401, {
        error: "invalid_client",
        error_description: "Client Authentication failed",
      });
    }

    this.tokenMints += 1;
    return json(200, {
      access_token: ACCESS_TOKEN,
      token_type: "Bearer",
      expires_in: this.tokenTtlSeconds,
    });
  }

  private route(
    method: string,
    path: string,
    body: Record<string, unknown>,
    headers: Record<string, string>,
  ): Response {
    if (method === "POST" && path === "/v2/checkout/orders") {
      return this.createOrder(body, headers);
    }

    const captureMatch = /^\/v2\/checkout\/orders\/([^/]+)\/capture$/.exec(path);
    if (method === "POST" && captureMatch) {
      return this.captureOrder(decodeURIComponent(captureMatch[1] ?? ""));
    }

    const getMatch = /^\/v2\/checkout\/orders\/([^/]+)$/.exec(path);
    if (method === "GET" && getMatch) {
      const order = this.orders.get(decodeURIComponent(getMatch[1] ?? ""));
      return order ? json(200, serialise(order)) : notFound();
    }

    const refundMatch = /^\/v2\/payments\/captures\/([^/]+)\/refund$/.exec(path);
    if (method === "POST" && refundMatch) {
      return this.refund(decodeURIComponent(refundMatch[1] ?? ""), body);
    }

    return notFound();
  }

  private createOrder(body: Record<string, unknown>, headers: Record<string, string>): Response {
    const key = headers["paypal-request-id"];
    const replayed = key ? this.idempotency.get(key) : undefined;
    if (replayed) {
      const existing = this.orders.get(replayed);
      if (existing) return json(200, serialise(existing));
    }

    const unit = asRecord((body.purchase_units as unknown[] | undefined)?.[0]);
    const amount = asRecord(unit.amount);

    this.sequence += 1;
    const order: FakeOrder = {
      id: `ORDER-TEST-${String(this.sequence).padStart(4, "0")}`,
      status: "CREATED",
      reference: String(unit.reference_id ?? ""),
      currency: String(amount.currency_code ?? "USD"),
      value: String(amount.value ?? "0"),
      captures: [],
      refunds: [],
    };

    this.orders.set(order.id, order);
    if (key) this.idempotency.set(key, order.id);
    return json(201, serialise(order));
  }

  private captureOrder(orderId: string): Response {
    const order = this.orders.get(orderId);
    if (!order) return notFound();

    if (order.status !== "APPROVED") {
      return json(422, {
        name: "UNPROCESSABLE_ENTITY",
        message: "The requested action could not be performed.",
        details: [{ issue: "ORDER_NOT_APPROVED" }],
      });
    }

    const capture: FakeCapture = { id: `CAPTURE-${order.id}`, status: "COMPLETED" };
    order.captures.push(capture);
    order.status = "COMPLETED";
    this.capturesToOrder.set(capture.id, order.id);
    return json(201, serialise(order));
  }

  private refund(captureId: string, body: Record<string, unknown>): Response {
    const orderId = this.capturesToOrder.get(captureId);
    const order = orderId ? this.orders.get(orderId) : undefined;
    if (!order) return notFound();

    const amount = asRecord(body.amount);
    const value = String(amount.value ?? order.value);
    const currency = String(amount.currency_code ?? order.currency);

    order.refunds.push({
      id: `REFUND-${order.id}-${order.refunds.length + 1}`,
      status: "COMPLETED",
      value,
      currency,
    });
    return json(201, { id: `REFUND-${order.id}`, status: "COMPLETED" });
  }
}

function serialise(order: FakeOrder): Record<string, unknown> {
  const payments =
    order.captures.length > 0 || order.refunds.length > 0
      ? {
          payments: {
            captures: order.captures.map((capture) => ({
              id: capture.id,
              status: capture.status,
              amount: { currency_code: order.currency, value: order.value },
            })),
            ...(order.refunds.length > 0
              ? {
                  refunds: order.refunds.map((refund) => ({
                    id: refund.id,
                    status: refund.status,
                    amount: { currency_code: refund.currency, value: refund.value },
                  })),
                }
              : {}),
          },
        }
      : {};

  return {
    id: order.id,
    status: order.status,
    purchase_units: [
      {
        reference_id: order.reference,
        custom_id: order.reference,
        amount: { currency_code: order.currency, value: order.value },
        ...payments,
      },
    ],
    links: [
      { rel: "self", href: `https://paypal.test/v2/checkout/orders/${order.id}`, method: "GET" },
      {
        rel: "payer-action",
        href: `https://paypal.test/checkoutnow?token=${order.id}`,
        method: "GET",
      },
    ],
  };
}

function notFound(): Response {
  return json(404, {
    name: "RESOURCE_NOT_FOUND",
    message: "The specified resource does not exist.",
    details: [{ issue: "INVALID_RESOURCE_ID" }],
  });
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function normaliseHeaders(headers: RequestInit["headers"]): Record<string, string> {
  const entries = new Headers(headers ?? {});
  return Object.fromEntries(
    [...entries.entries()].map(([key, value]) => [key.toLowerCase(), value]),
  );
}
