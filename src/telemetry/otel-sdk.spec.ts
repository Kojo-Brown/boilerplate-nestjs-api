import { context, diag, metrics, propagation, trace } from "@opentelemetry/api";
import { logs } from "@opentelemetry/api-logs";
import { SamplingDecision, type Context } from "@opentelemetry/api";
import { ROOT_CONTEXT, SpanKind, TraceFlags } from "@opentelemetry/api";
import { telemetryOptionsFrom } from "./telemetry.options";
import { telemetryEnvSchema } from "./telemetry.env";
import {
  UNTRACED_PATH_PREFIXES,
  buildResource,
  buildSampler,
  isUntracedPath,
  startTelemetry,
} from "./otel-sdk";

const options = (env: Record<string, string>, nodeEnv = "test") =>
  telemetryOptionsFrom(telemetryEnvSchema.parse(env), nodeEnv);

describe("isUntracedPath", () => {
  it.each(UNTRACED_PATH_PREFIXES)("drops %s", (prefix) => {
    expect(isUntracedPath(prefix)).toBe(true);
  });

  it("drops a route below a listed prefix", () => {
    expect(isUntracedPath("/v1/health/ready")).toBe(true);
    expect(isUntracedPath("/docs/swagger-ui.css")).toBe(true);
  });

  it("drops a probe that carries a query string", () => {
    expect(isUntracedPath("/v1/health?verbose=1")).toBe(true);
  });

  /**
   * A prefix match on the raw string would swallow this, and `/v1/healthcheck`
   * is somebody's real endpoint rather than a probe.
   */
  it("keeps a path that merely starts with the same characters", () => {
    expect(isUntracedPath("/v1/healthcheck")).toBe(false);
  });

  it("keeps ordinary routes, and tolerates a request with no url", () => {
    expect(isUntracedPath("/v1/users")).toBe(false);
    expect(isUntracedPath(undefined)).toBe(false);
  });
});

describe("buildResource", () => {
  it("carries the service name and the environment", () => {
    const attributes = buildResource(options({ OTEL_SERVICE_NAME: "checkout" })).attributes;

    expect(attributes["service.name"]).toBe("checkout");
    expect(attributes["deployment.environment.name"]).toBe("test");
  });

  /**
   * Omitted rather than defaulted: `service.version` absent is honest, where a
   * made-up `0.0.0` makes every deploy look like the same build.
   */
  it("omits the version when none was configured", () => {
    expect(buildResource(options({})).attributes["service.version"]).toBeUndefined();
    expect(
      buildResource(options({ OTEL_SERVICE_VERSION: "2.1.0" })).attributes["service.version"],
    ).toBe("2.1.0");
  });

  it("keeps the SDK's own default attributes", () => {
    expect(buildResource(options({})).attributes["telemetry.sdk.language"]).toBe("nodejs");
  });
});

describe("buildSampler", () => {
  const sample = (sampler: ReturnType<typeof buildSampler>, traceId: string, parent?: Context) =>
    sampler.shouldSample(parent ?? ROOT_CONTEXT, traceId, "span", SpanKind.SERVER, {}, []).decision;

  it("drops everything at a ratio of zero and keeps everything at one", () => {
    const traceId = "4bf92f3577b34da6a3ce929d0e0e4736";

    expect(sample(buildSampler(0), traceId)).toBe(SamplingDecision.NOT_RECORD);
    expect(sample(buildSampler(1), traceId)).toBe(SamplingDecision.RECORD_AND_SAMPLED);
  });

  /**
   * The property that makes a distributed trace whole. A request arriving with
   * a sampled `traceparent` is kept whatever this service's ratio says —
   * resampling at each hop is what produces traces with holes in them.
   */
  it("honours a sampled parent even at a ratio of zero", () => {
    const parent = trace.setSpanContext(ROOT_CONTEXT, {
      traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
      spanId: "00f067aa0ba902b7",
      traceFlags: TraceFlags.SAMPLED,
      isRemote: true,
    });

    expect(sample(buildSampler(0), "4bf92f3577b34da6a3ce929d0e0e4736", parent)).toBe(
      SamplingDecision.RECORD_AND_SAMPLED,
    );
  });

  it("honours an unsampled parent even at a ratio of one", () => {
    const parent = trace.setSpanContext(ROOT_CONTEXT, {
      traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
      spanId: "00f067aa0ba902b7",
      traceFlags: TraceFlags.NONE,
      isRemote: true,
    });

    expect(sample(buildSampler(1), "4bf92f3577b34da6a3ce929d0e0e4736", parent)).toBe(
      SamplingDecision.NOT_RECORD,
    );
  });
});

describe("startTelemetry", () => {
  /**
   * The default, and the one that must cost nothing: no provider registered
   * anywhere, so the API globals stay at their no-op implementations and every
   * `startActiveSpan` in the codebase is a function call.
   */
  it("installs nothing at all when the exporter is none", async () => {
    const handle = startTelemetry(options({}));

    expect(handle.enabled).toBe(false);
    // A no-op tracer produces a span with the invalid (all-zero) context.
    const spanContext = trace.getTracer("spec").startSpan("noop").spanContext();
    expect(trace.isSpanContextValid(spanContext)).toBe(false);
    expect(metrics.getMeterProvider().constructor.name).toBe("NoopMeterProvider");
    // The logs API always hands back a proxy, so the observable property is
    // that emitting through it reaches nothing and costs nothing.
    expect(() => logs.getLogger("spec").emit({ body: "nowhere" })).not.toThrow();

    await expect(handle.shutdown()).resolves.toBeUndefined();
  });

  it("refuses otlp options with no endpoint rather than silently posting to localhost", () => {
    const withoutEndpoint = { ...options({}), exporter: "otlp" as const };

    expect(() => startTelemetry(withoutEndpoint)).toThrow(
      /OTEL_EXPORTER_OTLP_ENDPOINT is required/,
    );
  });

  /**
   * The whole installation, on the one exporter that needs no collector.
   *
   * Worth running rather than reasoning about, because two of the things it
   * proves have no other coverage: that the providers are wired together
   * correctly enough for a span to be recorded at all, and that `shutdown()`
   * settles — a hang there is a rolling deploy that ends in the force-exit
   * path in `main.ts`.
   *
   * Everything it installs is a process-wide global that outlives Jest's
   * module registry, so the teardown is as much a part of this spec as the
   * assertions.
   */
  describe("with the console exporter", () => {
    let handle: Awaited<ReturnType<typeof startTelemetry>> | null = null;
    let written: jest.SpyInstance;
    let warned: jest.SpyInstance;

    beforeEach(() => {
      // `ConsoleSpanExporter` prints an ended span; the spec ends one.
      written = jest.spyOn(console, "dir").mockImplementation(() => undefined);
      // `diag.setLogger` warns when it replaces one, and a worker that has
      // already run this file's neighbours has one registered. Expected, and
      // not worth printing a stack trace over on every run.
      warned = jest.spyOn(console, "warn").mockImplementation(() => undefined);
    });

    afterEach(async () => {
      await handle?.shutdown();
      handle = null;
      written.mockRestore();
      warned.mockRestore();
      trace.disable();
      metrics.disable();
      propagation.disable();
      context.disable();
      logs.disable();
      diag.disable();
    });

    it("records real spans, propagates W3C context, and shuts down cleanly", async () => {
      handle = startTelemetry(options({ OTEL_EXPORTER: "console" }));
      expect(handle.enabled).toBe(true);

      const headers: Record<string, string> = {};
      trace.getTracer("spec").startActiveSpan("work", (span) => {
        propagation.inject(context.active(), headers);
        span.end();
      });

      // A real provider, so the span has a valid, sampled context.
      expect(headers["traceparent"]).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
      // And the baggage propagator is in the composite, not just trace context.
      expect(propagation.fields()).toEqual(expect.arrayContaining(["traceparent", "baggage"]));

      await expect(handle.shutdown()).resolves.toBeUndefined();
      handle = null;
      // The processor batches, so nothing has been written until the flush that
      // `shutdown()` performs — which is the property that makes flushing on
      // the way out of `main.ts` load-bearing rather than tidy.
      expect(written).toHaveBeenCalled();
    });
  });
});
