/**
 * Shared plumbing for the HTTP-backed providers.
 *
 * Both adapters talk to their gateway with `fetch` rather than a vendor SDK.
 * Stripe's SDK would be defensible; PayPal's server SDK for the Orders v2 API
 * was deprecated by PayPal itself, so half the pair would be a direct HTTP
 * client regardless. Two adapters written the same way are easier to hold to
 * one contract than one SDK wrapper and one HTTP client.
 */

/** Anything slower than this is a failed request, not a slow one. */
export const PAYMENT_HTTP_TIMEOUT_MS = 10_000;

export interface HttpJsonResponse {
  readonly status: number;
  readonly ok: boolean;
  /** Parsed JSON body, or `null` for an empty (204) response. */
  readonly body: unknown;
}

/**
 * Performs a request and parses the body, never throwing for a non-2xx.
 *
 * Providers decide what a given status means — a 404 from `find()` is `null`,
 * the same 404 from `capture()` is an error — so transport stays here and
 * interpretation stays with the adapter.
 */
export async function requestJson(
  url: string,
  init: RequestInit,
  timeoutMs: number = PAYMENT_HTTP_TIMEOUT_MS,
): Promise<HttpJsonResponse> {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  const text = await response.text();

  let body: unknown = null;
  if (text.length > 0) {
    try {
      body = JSON.parse(text);
    } catch {
      // A gateway returning HTML — a proxy error page, usually — is a failure
      // even on a 200. Surfacing the raw text lets the adapter say so.
      body = { rawBody: text.slice(0, 500) };
    }
  }

  return { status: response.status, ok: response.ok, body };
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
