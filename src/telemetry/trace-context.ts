import {
  ROOT_CONTEXT,
  context,
  propagation,
  trace,
  type Context,
  type TextMapGetter,
} from "@opentelemetry/api";

/**
 * The two W3C Trace Context headers, as the recommendation spells them.
 *
 * Lower case is not a style choice: the recommendation defines the field names
 * in lower case and says a receiver must accept them case-insensitively, which
 * is why {@link headerCarrierGetter} lowercases on the way in but everything
 * this service *writes* is exactly these two strings.
 */
export const TRACEPARENT_HEADER = "traceparent";
export const TRACESTATE_HEADER = "tracestate";

/**
 * Trace context, flattened into two nullable strings.
 *
 * This is the shape trace context takes when it has to be *stored* rather than
 * sent — two columns on `outbox_events`, in the form a header would have had.
 * Deliberately not a parsed structure: the value is opaque to this service, the
 * propagator owns its format, and a `tracestate` entry belonging to a vendor
 * nobody here has heard of has to survive the round trip unchanged.
 */
export interface TraceCarrier {
  readonly traceparent: string | null;
  readonly tracestate: string | null;
}

export const EMPTY_TRACE_CARRIER: TraceCarrier = { traceparent: null, tracestate: null };

/**
 * Reads trace context out of a map of message or request headers.
 *
 * The API's `defaultTextMapGetter` indexes the carrier directly, which is
 * correct for anything this service wrote and wrong for a message somebody
 * else's producer wrote with a `Traceparent` header: an exact-match lookup
 * misses it, the span is orphaned, and the trace silently splits in two at the
 * service boundary. Case folding is cheap and the failure it prevents is
 * invisible.
 */
export const headerCarrierGetter: TextMapGetter<Readonly<Record<string, string>>> = {
  keys: (carrier) => Object.keys(carrier),
  get: (carrier, key) => {
    const direct = carrier[key];
    if (direct !== undefined) return direct;
    const wanted = key.toLowerCase();
    for (const [name, value] of Object.entries(carrier)) {
      if (name.toLowerCase() === wanted) return value;
    }
    return undefined;
  },
};

/**
 * Writes the active context's `traceparent` (and `tracestate`, when there is
 * one) into a header map, in place.
 *
 * Goes through the global propagator rather than formatting the header here, so
 * the wire format is whatever was registered — W3C by default, and anything an
 * operator composes on top of it without this call site changing. With
 * telemetry off nothing is registered, the propagator is the API's no-op, and
 * the map comes back untouched: no headers, rather than headers describing a
 * trace that does not exist.
 */
export function injectTraceContext(
  headers: Record<string, string>,
  from: Context = context.active(),
): void {
  propagation.inject(from, headers);
}

/**
 * The context a message or request arrived under, as a parent for the span
 * about to be started.
 *
 * Extracted onto `ROOT_CONTEXT` and not onto the active one: a consumer's
 * active context at this point is whatever the broker client left behind —
 * often a span for the poll that fetched the batch — and parenting a message's
 * processing span to the fetch that happened to deliver it puts every message
 * in a batch under one unrelated parent instead of under the request that
 * produced it.
 */
export function extractTraceContext(headers: Readonly<Record<string, string>>): Context {
  return propagation.extract(ROOT_CONTEXT, headers, headerCarrierGetter);
}

/**
 * The active trace context, in the form that can be written to a database.
 *
 * Used by the outbox: an event is staged inside the request that caused it and
 * relayed by a poller minutes later, in another process, so the only way the
 * published message can name the request as its parent is for the request to
 * have written its own context down. See `docs/telemetry.md`.
 */
export function currentTraceCarrier(from: Context = context.active()): TraceCarrier {
  const headers: Record<string, string> = {};
  propagation.inject(from, headers);
  return {
    traceparent: headers[TRACEPARENT_HEADER] ?? null,
    tracestate: headers[TRACESTATE_HEADER] ?? null,
  };
}

/**
 * The reverse of {@link currentTraceCarrier}: two stored strings back into a
 * context.
 *
 * A carrier with no `traceparent` yields the root context, which is the right
 * answer rather than an error — rows staged before this column existed, and
 * rows staged while telemetry was switched off, are both perfectly ordinary and
 * simply start a new trace when they are eventually published.
 */
export function contextFromTraceCarrier(carrier: TraceCarrier): Context {
  if (carrier.traceparent === null) return ROOT_CONTEXT;
  const headers: Record<string, string> = { [TRACEPARENT_HEADER]: carrier.traceparent };
  if (carrier.tracestate !== null) headers[TRACESTATE_HEADER] = carrier.tracestate;
  return propagation.extract(ROOT_CONTEXT, headers, headerCarrierGetter);
}

/**
 * `traceId`/`spanId` for a log line, or `null` when nothing is being recorded.
 *
 * The names are the ones the OpenTelemetry logs data model uses, so a log
 * shipped by any collector — ours or a sidecar tailing stdout — joins the trace
 * without a rename rule in between.
 */
export function activeTraceFields(
  from: Context = context.active(),
): { readonly traceId: string; readonly spanId: string } | null {
  const spanContext = trace.getSpanContext(from);
  if (spanContext === undefined || !trace.isSpanContextValid(spanContext)) return null;
  return { traceId: spanContext.traceId, spanId: spanContext.spanId };
}
