/**
 * An in-process stand-in for the Stripe PaymentIntents API.
 *
 * It exists so `StripePaymentProvider` can be held to the same behavioural
 * contract as every other provider. A `jest.fn()` returning canned JSON would
 * only prove the adapter agrees with whatever the test happens to hand it; this
 * keeps state, so a capture really does have to follow an authorize and a
 * refund really is bounded by what was captured.
 *
 * Two deliberate simplifications, both noted where they bite:
 *  - intents are created already `requires_capture`, i.e. the client-side
 *    confirmation has happened. The adapter drives only the server-side steps.
 *  - only the fields the adapter reads are returned.
 */

interface FakeIntent {
  id: string;
  status: string;
  amount: number;
  currency: string;
  reference: string;
  chargeId: string;
  amountRefunded: number;
}

export interface FakeStripeRequest {
  readonly method: string;
  readonly path: string;
  readonly headers: Record<string, string>;
  readonly form: URLSearchParams;
}

export class FakeStripeApi {
  private readonly intents = new Map<string, FakeIntent>();
  private readonly idempotency = new Map<string, string>();
  private sequence = 0;

  /** Every request the adapter made, in order. Asserted on for wire details. */
  readonly requests: FakeStripeRequest[] = [];

  constructor(
    private readonly baseUrl: string,
    private readonly secretKey: string,
  ) {}

  /** Drop-in replacement for `global.fetch`. */
  readonly fetch: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input.toString());
    const method = init?.method ?? "GET";
    const headers = normaliseHeaders(init?.headers);
    const form = new URLSearchParams(typeof init?.body === "string" ? init.body : "");

    if (!url.toString().startsWith(this.baseUrl)) {
      throw new Error(`FakeStripeApi received a request for an unexpected host: ${url.toString()}`);
    }
    this.requests.push({ method, path: url.pathname, headers, form });

    if (headers.authorization !== `Bearer ${this.secretKey}`) {
      return json(401, {
        error: { type: "invalid_request_error", message: "Invalid API Key provided" },
      });
    }

    return this.route(method, url, form, headers);
  };

  private route(
    method: string,
    url: URL,
    form: URLSearchParams,
    headers: Record<string, string>,
  ): Response {
    const path = url.pathname;

    if (method === "POST" && path === "/v1/payment_intents") {
      return this.createIntent(form, headers);
    }

    const captureMatch = /^\/v1\/payment_intents\/([^/]+)\/capture$/.exec(path);
    if (method === "POST" && captureMatch) {
      return this.captureIntent(decodeURIComponent(captureMatch[1] ?? ""));
    }

    const retrieveMatch = /^\/v1\/payment_intents\/([^/]+)$/.exec(path);
    if (method === "GET" && retrieveMatch) {
      const intent = this.intents.get(decodeURIComponent(retrieveMatch[1] ?? ""));
      return intent ? json(200, serialise(intent)) : notFound();
    }

    if (method === "POST" && path === "/v1/refunds") {
      return this.refund(form);
    }

    return notFound();
  }

  private createIntent(form: URLSearchParams, headers: Record<string, string>): Response {
    const key = headers["idempotency-key"];
    const replayed = key ? this.idempotency.get(key) : undefined;
    if (replayed) {
      const existing = this.intents.get(replayed);
      if (existing) return json(200, serialise(existing));
    }

    this.sequence += 1;
    const intent: FakeIntent = {
      id: `pi_test_${String(this.sequence).padStart(6, "0")}`,
      // See the class comment: the confirmation step is assumed done.
      status: "requires_capture",
      amount: Number(form.get("amount")),
      currency: form.get("currency") ?? "usd",
      reference: form.get("metadata[reference]") ?? "",
      chargeId: `ch_test_${String(this.sequence).padStart(6, "0")}`,
      amountRefunded: 0,
    };

    this.intents.set(intent.id, intent);
    if (key) this.idempotency.set(key, intent.id);
    return json(200, serialise(intent));
  }

  private captureIntent(id: string): Response {
    const intent = this.intents.get(id);
    if (!intent) return notFound();

    if (intent.status !== "requires_capture") {
      return json(400, {
        error: {
          type: "invalid_request_error",
          code: "payment_intent_unexpected_state",
          message: `This PaymentIntent's status is "${intent.status}" and cannot be captured.`,
        },
      });
    }

    intent.status = "succeeded";
    return json(200, serialise(intent));
  }

  private refund(form: URLSearchParams): Response {
    const intent = this.intents.get(form.get("payment_intent") ?? "");
    if (!intent) {
      return json(400, {
        error: {
          type: "invalid_request_error",
          code: "resource_missing",
          message: "No such payment_intent",
        },
      });
    }
    if (intent.status !== "succeeded") {
      return json(400, {
        error: {
          type: "invalid_request_error",
          code: "charge_disputed",
          message: "This PaymentIntent has not been captured.",
        },
      });
    }

    const requested = form.has("amount")
      ? Number(form.get("amount"))
      : intent.amount - intent.amountRefunded;
    if (requested > intent.amount - intent.amountRefunded) {
      return json(400, {
        error: {
          type: "invalid_request_error",
          code: "amount_too_large",
          message: "Refund amount exceeds the remaining balance.",
        },
      });
    }

    intent.amountRefunded += requested;
    return json(200, {
      id: `re_test_${intent.chargeId}`,
      object: "refund",
      amount: requested,
      currency: intent.currency,
    });
  }
}

/**
 * Only the fields `StripePaymentProvider.toPayment()` reads, plus
 * `latest_charge` as an object — the adapter always asks for it expanded, and
 * the refunded total lives nowhere else.
 */
function serialise(intent: FakeIntent): Record<string, unknown> {
  return {
    id: intent.id,
    object: "payment_intent",
    status: intent.status,
    amount: intent.amount,
    currency: intent.currency,
    client_secret: `${intent.id}_secret_test`,
    metadata: { reference: intent.reference },
    latest_charge: {
      id: intent.chargeId,
      object: "charge",
      amount: intent.amount,
      amount_refunded: intent.amountRefunded,
      refunded: intent.amountRefunded >= intent.amount,
    },
  };
}

function notFound(): Response {
  return json(404, {
    error: {
      type: "invalid_request_error",
      code: "resource_missing",
      message: "No such payment_intent",
    },
  });
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function normaliseHeaders(headers: RequestInit["headers"]): Record<string, string> {
  const entries = new Headers(headers ?? {});
  return Object.fromEntries(
    [...entries.entries()].map(([key, value]) => [key.toLowerCase(), value]),
  );
}
