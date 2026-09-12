import { SpanStatusCode, trace } from "@opentelemetry/api";
import { installInMemoryTelemetry, type TelemetryProbe } from "@/test-utils/in-memory-telemetry";
import { INSTRUMENTATION_SCOPE, meterFor, recordSpanError, tracerFor } from "./spans";

describe("tracerFor / meterFor", () => {
  let probe: TelemetryProbe;

  beforeEach(() => {
    probe = installInMemoryTelemetry();
  });

  afterEach(async () => {
    await probe.shutdown();
  });

  /**
   * The scope is how a backend tells this service's own instrumentation apart
   * from a library's, and one flat name for the whole service would make the
   * outbox's spans indistinguishable from the consumer's.
   */
  it("scopes a tracer under the service and the component", () => {
    tracerFor("outbox").startActiveSpan("work", (span) => span.end());

    expect(probe.spans()[0]?.instrumentationScope.name).toBe(`${INSTRUMENTATION_SCOPE}/outbox`);
  });

  it("scopes a meter the same way", async () => {
    meterFor("outbox").createCounter("spec.counter").add(1);

    const collected = await probe.collectMetrics();
    expect(collected.scopeMetrics.map((scope) => scope.scope.name)).toContain(
      `${INSTRUMENTATION_SCOPE}/outbox`,
    );
  });
});

describe("recordSpanError", () => {
  let probe: TelemetryProbe;

  beforeEach(() => {
    probe = installInMemoryTelemetry();
  });

  afterEach(async () => {
    await probe.shutdown();
  });

  /**
   * Both halves, because they are read by different things: the event is what
   * an engineer opens, the status is what a backend counts and alerts on. A
   * span with the exception and no status is a successful operation with an odd
   * event attached to it.
   */
  it("sets the error status and attaches the exception", () => {
    trace.getTracer("spec").startActiveSpan("work", (span) => {
      recordSpanError(span, new Error("broker unreachable"));
      span.end();
    });

    const [recorded] = probe.spans();
    expect(recorded?.status).toEqual({
      code: SpanStatusCode.ERROR,
      message: "broker unreachable",
    });
    expect(recorded?.events[0]?.name).toBe("exception");
    expect(recorded?.events[0]?.attributes?.["exception.message"]).toBe("broker unreachable");
  });

  it("copes with something that was thrown but is not an Error", () => {
    trace.getTracer("spec").startActiveSpan("work", (span) => {
      recordSpanError(span, "a string nobody should have thrown");
      span.end();
    });

    expect(probe.spans()[0]?.status.message).toBe("a string nobody should have thrown");
  });
});
