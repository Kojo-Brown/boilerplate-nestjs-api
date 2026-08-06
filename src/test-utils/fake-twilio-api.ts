/**
 * An in-process stand-in for Twilio's Programmable Messaging API.
 *
 * Same reasoning as `FakeStripeApi` and `FakePaypalApi`: a `jest.fn()` that
 * resolves with a canned body proves the channel can read a shape someone typed
 * out, not that it can talk to Twilio. This enforces the parts of the real
 * contract the channel depends on — HTTP basic auth, form encoding, a `From` or
 * `MessagingServiceSid` but not neither, E.164 on `To` — so a channel that gets
 * any of them wrong fails here rather than in production.
 *
 * Only `POST /2010-04-01/Accounts/{sid}/Messages.json` is implemented, because
 * that is the entire surface `SmsNotificationChannel` uses. Anything else
 * answers 404 rather than pretending.
 */
export class FakeTwilioApi {
  private sequence = 0;
  private readonly sent: { to: string; body: string; from: string }[] = [];

  /**
   * Numbers that fail, keyed by the Twilio error code to fail them with.
   * Lets a test drive the permanent-vs-transient branches without reaching for
   * a mock.
   */
  private readonly rejections = new Map<string, { code: number; message: string }>();

  /** Numbers accepted with a 201 whose body already says the send failed. */
  private readonly asyncFailures = new Map<string, { status: string; code: number }>();

  constructor(
    private readonly baseUrl: string,
    private readonly accountSid: string,
    private readonly authToken: string,
  ) {}

  /** Every message the fake accepted, oldest first. */
  get messages(): readonly { to: string; body: string; from: string }[] {
    return this.sent;
  }

  /** Makes `to` fail synchronously with a Twilio error code. */
  rejectNumber(to: string, code: number, message: string): void {
    this.rejections.set(to, { code, message });
  }

  /** Makes `to` be accepted but come back already `failed`/`undelivered`. */
  failAfterAccept(to: string, status: string, code: number): void {
    this.asyncFailures.set(to, { status, code });
  }

  readonly fetch: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input.toString());
    const path = `${url.origin}${url.pathname}`;
    const expected = `${this.baseUrl}/2010-04-01/Accounts/${this.accountSid}/Messages.json`;

    if (init?.method !== "POST" || path !== expected) {
      return json(404, { code: 20404, message: "The requested resource was not found" });
    }

    const auth = headerOf(init, "authorization");
    const expectedAuth = `Basic ${Buffer.from(`${this.accountSid}:${this.authToken}`).toString("base64")}`;
    if (auth !== expectedAuth) {
      return json(401, { code: 20003, message: "Authenticate", status: 401 });
    }

    if (headerOf(init, "content-type") !== "application/x-www-form-urlencoded") {
      return json(400, {
        code: 20001,
        message: "Twilio's REST API takes form-encoded parameters",
        status: 400,
      });
    }

    const form = new URLSearchParams(typeof init.body === "string" ? init.body : "");
    const to = form.get("To") ?? "";
    const body = form.get("Body") ?? "";
    const from = form.get("From") ?? form.get("MessagingServiceSid") ?? "";

    if (!from) {
      return json(400, {
        code: 21603,
        message: "A 'From' phone number is required.",
        more_info: "https://www.twilio.com/docs/errors/21603",
        status: 400,
      });
    }
    if (!/^\+[1-9]\d{1,14}$/.test(to)) {
      return json(400, {
        code: 21211,
        message: `The 'To' number ${to} is not a valid phone number.`,
        more_info: "https://www.twilio.com/docs/errors/21211",
        status: 400,
      });
    }
    if (!body) {
      return json(400, {
        code: 21602,
        message: "Message body is required.",
        more_info: "https://www.twilio.com/docs/errors/21602",
        status: 400,
      });
    }

    const rejection = this.rejections.get(to);
    if (rejection) {
      return json(400, {
        code: rejection.code,
        message: rejection.message,
        more_info: `https://www.twilio.com/docs/errors/${rejection.code}`,
        status: 400,
      });
    }

    this.sequence += 1;
    const sid = `SM${String(this.sequence).padStart(32, "0")}`;
    const asyncFailure = this.asyncFailures.get(to);

    if (!asyncFailure) this.sent.push({ to, body, from });

    // Twilio answers a successful create with 201, not 200.
    return json(201, {
      sid,
      account_sid: this.accountSid,
      to,
      from: from.startsWith("MG") ? null : from,
      messaging_service_sid: from.startsWith("MG") ? from : null,
      body,
      status: asyncFailure?.status ?? "queued",
      error_code: asyncFailure?.code ?? null,
      error_message: asyncFailure ? `Message delivery failed (${asyncFailure.code})` : null,
      num_segments: String(Math.max(1, Math.ceil(body.length / 160))),
      price: null,
    });
  };
}

function headerOf(init: RequestInit, name: string): string | null {
  const headers = init.headers;
  if (!headers) return null;
  const entries = Array.isArray(headers)
    ? headers
    : headers instanceof Headers
      ? [...headers.entries()]
      : Object.entries(headers);
  const match = entries.find(([key]) => key.toLowerCase() === name);
  return match ? String(match[1]) : null;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
