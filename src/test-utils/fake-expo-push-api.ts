/**
 * An in-process stand-in for the Expo Push API.
 *
 * Enforces the parts of the real contract `PushNotificationChannel` depends on:
 * the endpoint, JSON encoding, the bearer access token, a token-shaped `to`,
 * and — the one that actually catches bugs — the fact that Expo answers a
 * *batch* with one ticket per message, each independently `ok` or `error`. A
 * canned single-ticket response would hide every partial-failure path.
 */
interface ExpoTicket {
  status: "ok" | "error";
  id?: string;
  message?: string;
  details?: { error: string };
}

const EXPO_PUSH_TOKEN = /^Expo(nent)?PushToken\[[^\]]+\]$/;

export class FakeExpoPushApi {
  private sequence = 0;
  private readonly sent: { to: string; title: string; body: string; priority: string }[] = [];

  /** Tokens that come back as an error ticket, keyed by `details.error`. */
  private readonly deadTokens = new Map<string, string>();

  constructor(
    private readonly baseUrl: string,
    private readonly accessToken: string,
  ) {}

  /** Every message the fake accepted, oldest first. */
  get messages(): readonly { to: string; title: string; body: string; priority: string }[] {
    return this.sent;
  }

  /** Makes `token` come back as an error ticket — `DeviceNotRegistered` by default. */
  killToken(token: string, error = "DeviceNotRegistered"): void {
    this.deadTokens.set(token, error);
  }

  readonly fetch: typeof globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input.toString();

    if (init?.method !== "POST" || url !== `${this.baseUrl}/--/api/v2/push/send`) {
      return json(404, { errors: [{ code: "NOT_FOUND", message: "Not found" }] });
    }

    if (headerOf(init, "authorization") !== `Bearer ${this.accessToken}`) {
      return json(401, {
        errors: [{ code: "UNAUTHORIZED", message: "Invalid access token" }],
      });
    }

    const parsed: unknown = JSON.parse(typeof init.body === "string" ? init.body : "null");
    const messages = Array.isArray(parsed) ? parsed : [parsed];
    if (messages.length === 0 || messages.some((message) => message === null)) {
      return json(400, {
        errors: [
          { code: "PUSH_TOO_MANY_NOTIFICATIONS", message: "Expected a message or an array" },
        ],
      });
    }

    const tickets: ExpoTicket[] = messages.map((raw) => {
      const message = raw as { to?: string; title?: string; body?: string; priority?: string };
      const to = message.to ?? "";

      if (!EXPO_PUSH_TOKEN.test(to)) {
        return {
          status: "error",
          message: `"${to}" is not a registered push notification recipient`,
          details: { error: "DeviceNotRegistered" },
        };
      }

      const dead = this.deadTokens.get(to);
      if (dead) {
        return { status: "error", message: dead, details: { error: dead } };
      }

      this.sequence += 1;
      this.sent.push({
        to,
        title: message.title ?? "",
        body: message.body ?? "",
        priority: message.priority ?? "default",
      });
      return { status: "ok", id: `ticket-${this.sequence}` };
    });

    return json(200, { data: tickets });
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
