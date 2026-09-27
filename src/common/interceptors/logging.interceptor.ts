import { Injectable, NestInterceptor, ExecutionContext, CallHandler, Logger } from "@nestjs/common";
import { Observable } from "rxjs";
import { finalize } from "rxjs/operators";
import type { Request, Response } from "express";
import { randomUUID } from "crypto";
import { trace } from "@opentelemetry/api";
import type { AuthenticatedUser } from "@/auth/strategies/jwt.strategy";
import { activeTraceFields } from "@/telemetry";

export const CORRELATION_ID_HEADER = "x-correlation-id";

/**
 * The attribute the correlation id is put on the request's span.
 *
 * Not a semantic-convention name, because there is no convention for this: it
 * is this service's own id for a request, minted here when the caller did not
 * send one. It earns its place by being the join in both directions — an
 * operator holding a `x-correlation-id` from a client's bug report can find the
 * trace, and an operator holding a trace can find every log line that names it.
 */
export const CORRELATION_ID_ATTRIBUTE = "app.correlation_id";

interface RequestWithUser extends Request {
  user?: AuthenticatedUser;
}

@Injectable()
export class LoggingInterceptor implements NestInterceptor {
  private readonly logger = new Logger(LoggingInterceptor.name);

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = context.switchToHttp().getRequest<RequestWithUser>();
    const res = context.switchToHttp().getResponse<Response>();

    const correlationId =
      (req.headers[CORRELATION_ID_HEADER] as string | undefined) ?? randomUUID();
    const startedAt = Date.now();

    req.headers[CORRELATION_ID_HEADER] = correlationId;
    res.setHeader(CORRELATION_ID_HEADER, correlationId);

    // The span belongs to the HTTP and Express instrumentations, not to this
    // interceptor — which is the point. The request already has spans and both
    // the access log and the trace hang off them, rather than off a second,
    // redundant span that would deepen every trace and agree with the
    // instrumentation's about everything.
    //
    // `getActiveSpan()` is undefined when the SDK is off, and the whole block
    // costs one property read in that case.
    trace.getActiveSpan()?.setAttribute(CORRELATION_ID_ATTRIBUTE, correlationId);

    // `finalize` rather than `tap`, because an access log has to record every
    // request that ends, not only the ones that produce a value. An interceptor
    // downstream may answer the request itself and complete without emitting —
    // `IdempotencyInterceptor` does exactly that when it replays a stored
    // response — and a client that disconnects unsubscribes without either a
    // `next` or an `error`. Both used to leave no line at all.
    return next
      .handle()
      .pipe(finalize(() => this.writeLog(req, res.statusCode || 500, startedAt, correlationId)));
  }

  private writeLog(
    req: RequestWithUser,
    statusCode: number,
    startedAt: number,
    correlationId: string,
  ): void {
    const traceFields = activeTraceFields();
    const { path, query } = splitTarget(req.url);
    // An object rather than a pre-serialised string, which is what makes this
    // line redactable at all: `JSON.stringify` here would hand the logger one
    // opaque string, and a processor chain that walks fields cannot see inside
    // one. Everything below is a *field*, so the allowlist decides on it by name
    // — and a field added here later is redacted until somebody adds it to
    // `DEFAULT_ALLOWLIST`, which is the order this is meant to happen in.
    // See docs/log-redaction.md.
    this.logger.log({
      message: "request",
      correlationId,
      method: req.method,
      path,
      // Separate from the path, and this is the fix rather than a tidy-up.
      // `req.url` is the request *target*, query string included, and
      // `GET /v1/auth/google/callback?code=…` carries a single-use OAuth
      // authorisation code that is exchangeable for that person's tokens — so
      // the old `path: req.url` wrote a live credential to stdout and to the
      // logs pipeline on every successful Google sign-in. As one string it could
      // only be dropped or kept whole. Parsed into named parameters, the
      // allowlist keeps `query.page` and friends and redacts the rest, `code`
      // included, without anyone having had to predict it.
      query,
      statusCode,
      latencyMs: Date.now() - startedAt,
      userId: req.user?.id ?? null,
      // Spelled in snake_case, unlike every other field here, because these
      // two are not ours to name: they are the OpenTelemetry logs data
      // model's, and a collector scraping stdout joins a log line to its
      // trace by finding exactly these keys. `null` when the request is not
      // being recorded — either the SDK is off, or the sampler dropped this
      // trace — which is honest, where omitting the keys would leave a
      // collector unable to tell a dropped trace from a parse failure.
      //
      // Read inside `finalize`, which runs while the request's context is
      // still active, so these are the ids of the span the line describes.
      trace_id: traceFields?.traceId ?? null,
      span_id: traceFields?.spanId ?? null,
    });
  }
}

/**
 * Splits a request target into its path and its decoded query parameters.
 *
 * Hand-rolled rather than `new URL(target, base)`, because there is no base to
 * invent: the target is origin-form and a fabricated origin would appear in
 * nothing but a thrown error on the malformed inputs this has to survive. What
 * reaches here is whatever was written on the request line, so it may hold no
 * `?`, several, an empty query, a repeated key, or bytes that are not valid
 * percent-encoding.
 *
 * A repeated key keeps every value, as an array: `?tag=a&tag=b` becomes
 * `{tag:["a","b"]}`. Keeping only the last would misreport what arrived, and the
 * redactor treats both shapes alike — `tag[]` is one allowlist decision for
 * every element.
 */
export function splitTarget(target: string): {
  path: string;
  query: Record<string, string | string[]>;
} {
  const separator = target.indexOf("?");
  if (separator === -1) return { path: target, query: {} };

  const path = target.slice(0, separator);
  const query: Record<string, string | string[]> = {};

  for (const pair of target.slice(separator + 1).split("&")) {
    if (pair.length === 0) continue;
    const equals = pair.indexOf("=");
    // A bare `?flag` is a parameter with no value, which is not the same as one
    // whose value is empty. `true` would make it a boolean it never was, so the
    // empty string stands for both and the name — the part that matters here —
    // is preserved either way.
    const rawKey = equals === -1 ? pair : pair.slice(0, equals);
    const rawValue = equals === -1 ? "" : pair.slice(equals + 1);

    const key = decodeComponent(rawKey);
    const value = decodeComponent(rawValue);

    const existing = query[key];
    if (existing === undefined) query[key] = value;
    else if (Array.isArray(existing)) existing.push(value);
    else query[key] = [existing, value];
  }

  return { path, query };
}

/**
 * Percent-decoding that cannot throw.
 *
 * `decodeURIComponent` throws `URIError` on a lone `%` or a truncated escape,
 * both of which a caller can send deliberately. Thrown from inside the access
 * log it would become an error in `finalize`, on the path that exists to record
 * that the request happened — so a malformed query string would cost the line
 * describing it. The raw form is kept instead; it is redacted like any other
 * value.
 */
function decodeComponent(value: string): string {
  try {
    return decodeURIComponent(value.replace(/\+/g, " "));
  } catch {
    return value;
  }
}
