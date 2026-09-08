/**
 * Shared plumbing for the adapters that talk to a third-party JSON API.
 *
 * Every outbound integration in this codebase — the payment gateways, the SMS
 * and push notification channels — is a `fetch` client rather than a vendor
 * SDK. That began as a constraint (PayPal deprecated its server SDK for the
 * Orders v2 API, so half the payments pair had to be hand-written anyway) and
 * stayed as a decision: adapters written the same way are much easier to hold
 * to one behavioural contract than a mix of SDK wrappers and HTTP clients, and
 * each can be driven end-to-end by an in-process fake of the real API rather
 * than by mocking a vendor module.
 *
 * Lives under `common/` rather than inside one feature module so that neither
 * feature has to import the other's internals to reuse it.
 *
 * This file is the raw transport and nothing outside `common/http` calls it
 * directly: adapters go through {@link ResilientHttpClient}, which is what adds
 * the per-dependency circuit breaker and the retry ladder. That is why
 * `requestJson` is deliberately absent from the barrel — a call that skipped the
 * client would be an outbound request with no breaker in front of it, and
 * "every outbound call is protected" is only true if there is one way out.
 */

/** Anything slower than this is a failed request, not a slow one. */
export const DEFAULT_HTTP_TIMEOUT_MS = 10_000;

export interface HttpJsonResponse {
  readonly status: number;
  readonly ok: boolean;
  /** Parsed JSON body, or `null` for an empty (204) response. */
  readonly body: unknown;
  /**
   * `Retry-After` in milliseconds, when the upstream sent one.
   *
   * Parsed here rather than in the retry ladder because this is the only place
   * that still has the response headers — everything above this function sees
   * a plain object. `null` when the header is absent or unparseable.
   */
  readonly retryAfterMs: number | null;
}

/**
 * Performs a request and parses the body, never throwing for a non-2xx.
 *
 * Callers decide what a given status means — a 404 from a payment `find()` is
 * `null`, the same 404 from `capture()` is an error — so transport stays here
 * and interpretation stays with the adapter.
 */
export async function requestJson(
  url: string,
  init: RequestInit,
  timeoutMs: number = DEFAULT_HTTP_TIMEOUT_MS,
): Promise<HttpJsonResponse> {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  const text = await response.text();

  let body: unknown = null;
  if (text.length > 0) {
    try {
      body = JSON.parse(text);
    } catch {
      // An upstream returning HTML — a proxy error page, usually — is a failure
      // even on a 200. Surfacing the raw text lets the adapter say so.
      body = { rawBody: text.slice(0, 500) };
    }
  }

  return {
    status: response.status,
    ok: response.ok,
    body,
    retryAfterMs: parseRetryAfter(response.headers.get("retry-after"), Date.now()),
  };
}

/**
 * `Retry-After`, in milliseconds from now.
 *
 * RFC 9110 allows either delta-seconds or an HTTP-date, and upstreams use both:
 * Twilio and Stripe send seconds, a CDN in front of a gateway is as likely to
 * send a date. A date already in the past is `0` rather than a negative delay —
 * "retry now" is what an expired hint means, not "retry before you asked".
 *
 * `now` is a parameter so a test can pin the date arithmetic without freezing
 * the clock for everything else in the process.
 */
export function parseRetryAfter(header: string | null, now: number): number | null {
  if (header === null) return null;

  const trimmed = header.trim();
  if (trimmed.length === 0) return null;

  // `Number("")` is 0 and `Number("2 days")` is NaN — the empty case is already
  // out, so a finite non-negative number here really was delta-seconds.
  const seconds = Number(trimmed);
  if (Number.isFinite(seconds)) {
    return seconds >= 0 ? Math.round(seconds * 1000) : null;
  }

  const date = Date.parse(trimmed);
  if (Number.isNaN(date)) return null;
  return Math.max(0, date - now);
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function readString(source: Record<string, unknown> | null, key: string): string | null {
  const value = source?.[key];
  return typeof value === "string" ? value : null;
}

export function readNumber(source: Record<string, unknown> | null, key: string): number | null {
  const value = source?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function readArray(source: Record<string, unknown> | null, key: string): unknown[] {
  const value = source?.[key];
  return Array.isArray(value) ? value : [];
}
