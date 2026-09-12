import { context, trace } from "@opentelemetry/api";
import { installInMemoryTelemetry, type TelemetryProbe } from "@/test-utils/in-memory-telemetry";
import {
  EMPTY_TRACE_CARRIER,
  TRACEPARENT_HEADER,
  activeTraceFields,
  contextFromTraceCarrier,
  currentTraceCarrier,
  extractTraceContext,
  headerCarrierGetter,
  injectTraceContext,
} from "./trace-context";

/** A well-formed `traceparent`, from the W3C recommendation's own example. */
const SAMPLE_TRACEPARENT = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";
const SAMPLE_TRACE_ID = "4bf92f3577b34da6a3ce929d0e0e4736";
const SAMPLE_SPAN_ID = "00f067aa0ba902b7";

describe("headerCarrierGetter", () => {
  it("reads a header that is spelled exactly", () => {
    expect(headerCarrierGetter.get({ traceparent: SAMPLE_TRACEPARENT }, "traceparent")).toBe(
      SAMPLE_TRACEPARENT,
    );
  });

  /**
   * The reason this getter exists rather than the API's default one. A producer
   * in another language may write `Traceparent`; an exact-match lookup misses
   * it, the consumer's span is orphaned, and the trace splits in two at the
   * service boundary with nothing reporting an error.
   */
  it("reads a header somebody else's producer capitalised", () => {
    expect(headerCarrierGetter.get({ TraceParent: SAMPLE_TRACEPARENT }, "traceparent")).toBe(
      SAMPLE_TRACEPARENT,
    );
  });

  it("is undefined for a header that is not there", () => {
    expect(
      headerCarrierGetter.get({ "event-name": "user.registered" }, "traceparent"),
    ).toBeUndefined();
  });

  it("lists the carrier's keys", () => {
    expect(headerCarrierGetter.keys({ a: "1", b: "2" })).toEqual(["a", "b"]);
  });
});

describe("with no SDK installed", () => {
  it("injects nothing, because there is no trace to describe", () => {
    const headers: Record<string, string> = {};

    injectTraceContext(headers);

    expect(headers).toEqual({});
  });

  it("reports no trace fields for a log line", () => {
    expect(activeTraceFields()).toBeNull();
  });

  it("captures an empty carrier", () => {
    expect(currentTraceCarrier()).toEqual(EMPTY_TRACE_CARRIER);
  });
});

describe("with an SDK installed", () => {
  let probe: TelemetryProbe;

  beforeEach(() => {
    probe = installInMemoryTelemetry();
  });

  afterEach(async () => {
    await probe.shutdown();
  });

  const withSpan = <T>(run: () => T): T =>
    trace.getTracer("spec").startActiveSpan("work", (span) => {
      try {
        return run();
      } finally {
        span.end();
      }
    });

  it("injects the active span's traceparent", () => {
    const headers = withSpan(() => {
      const carrier: Record<string, string> = {};
      injectTraceContext(carrier);
      return carrier;
    });

    expect(headers[TRACEPARENT_HEADER]).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-0[01]$/);
  });

  it("reports the active span's ids for a log line", () => {
    const fields = withSpan(() => activeTraceFields());

    expect(fields).toEqual({
      traceId: expect.stringMatching(/^[0-9a-f]{32}$/),
      spanId: expect.stringMatching(/^[0-9a-f]{16}$/),
    });
  });

  it("makes an extracted context the parent of the next span", () => {
    const parent = extractTraceContext({ traceparent: SAMPLE_TRACEPARENT });

    context.with(parent, () => {
      trace.getTracer("spec").startActiveSpan("child", (span) => span.end());
    });

    const [child] = probe.spans();
    expect(child?.spanContext().traceId).toBe(SAMPLE_TRACE_ID);
    expect(child?.parentSpanContext?.spanId).toBe(SAMPLE_SPAN_ID);
  });

  /**
   * The property the outbox's two columns rest on: what is captured inside the
   * request has to reconstitute, in another process and minutes later, into a
   * context that still names that request.
   */
  it("round-trips a stored carrier back into the same trace", () => {
    const carrier = withSpan(() => currentTraceCarrier());
    const [staging] = probe.spans();

    context.with(contextFromTraceCarrier(carrier), () => {
      trace.getTracer("spec").startActiveSpan("relayed", (span) => span.end());
    });

    const relayed = probe.spans()[1];
    expect(relayed?.spanContext().traceId).toBe(staging?.spanContext().traceId);
    expect(relayed?.parentSpanContext?.spanId).toBe(staging?.spanContext().spanId);
  });

  it("treats a carrier with no traceparent as the root, not as an error", () => {
    context.with(contextFromTraceCarrier(EMPTY_TRACE_CARRIER), () => {
      trace.getTracer("spec").startActiveSpan("fresh", (span) => span.end());
    });

    const [fresh] = probe.spans();
    expect(fresh?.parentSpanContext).toBeUndefined();
  });

  it("carries tracestate through the round trip untouched", () => {
    const carrier = contextFromTraceCarrier({
      traceparent: SAMPLE_TRACEPARENT,
      tracestate: "vendor=t61rcWkgMzE",
    });

    expect(trace.getSpanContext(carrier)?.traceState?.get("vendor")).toBe("t61rcWkgMzE");
  });
});
