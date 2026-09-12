import {
  LoggingInterceptor,
  CORRELATION_ID_ATTRIBUTE,
  CORRELATION_ID_HEADER,
} from "./logging.interceptor";
import type { ExecutionContext, CallHandler } from "@nestjs/common";
import { Logger } from "@nestjs/common";
import { EMPTY, of, throwError, firstValueFrom, lastValueFrom } from "rxjs";
import { context as otelContext, trace } from "@opentelemetry/api";
import { installInMemoryTelemetry, type TelemetryProbe } from "@/test-utils/in-memory-telemetry";

function makeContext(overrides?: {
  correlationId?: string;
  user?: { id: string; email: string; role: string };
}): {
  context: ExecutionContext;
  resHeaders: Record<string, string>;
  reqHeaders: Record<string, string>;
} {
  const resHeaders: Record<string, string> = {};
  const reqHeaders: Record<string, string> = overrides?.correlationId
    ? { [CORRELATION_ID_HEADER]: overrides.correlationId }
    : {};

  const context = {
    switchToHttp: () => ({
      getRequest: () => ({
        method: "GET",
        url: "/v1/users",
        headers: reqHeaders,
        user: overrides?.user,
      }),
      getResponse: () => ({
        statusCode: 200,
        setHeader: (key: string, value: string) => {
          resHeaders[key] = value;
        },
      }),
    }),
  } as unknown as ExecutionContext;

  return { context, resHeaders, reqHeaders };
}

function makeHandler(data: unknown = { ok: true }): CallHandler {
  return { handle: () => of(data) } as unknown as CallHandler;
}

function makeErrorHandler(err: Error): CallHandler {
  return { handle: () => throwError(() => err) } as unknown as CallHandler;
}

describe("LoggingInterceptor", () => {
  let interceptor: LoggingInterceptor;
  let logSpy: jest.SpyInstance;

  beforeEach(() => {
    interceptor = new LoggingInterceptor();
    logSpy = jest.spyOn(Logger.prototype, "log").mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("passes a new UUID correlation ID in response header when none provided", async () => {
    const { context, resHeaders } = makeContext();
    await firstValueFrom(interceptor.intercept(context, makeHandler()));
    expect(resHeaders[CORRELATION_ID_HEADER]).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  });

  it("echoes back the caller's correlation ID when provided", async () => {
    const { context, resHeaders } = makeContext({ correlationId: "my-trace-123" });
    await firstValueFrom(interceptor.intercept(context, makeHandler()));
    expect(resHeaders[CORRELATION_ID_HEADER]).toBe("my-trace-123");
  });

  it("logs method, path, statusCode, latencyMs, and null userId for unauthenticated requests", async () => {
    const { context } = makeContext();
    await firstValueFrom(interceptor.intercept(context, makeHandler()));
    expect(logSpy).toHaveBeenCalledTimes(1);
    const logged = JSON.parse(logSpy.mock.calls[0]?.[0] as string) as Record<string, unknown>;
    expect(logged.method).toBe("GET");
    expect(logged.path).toBe("/v1/users");
    expect(logged.statusCode).toBe(200);
    expect(typeof logged.latencyMs).toBe("number");
    expect(logged.userId).toBeNull();
  });

  it("logs userId when the request carries an authenticated user", async () => {
    const { context } = makeContext({ user: { id: "user-42", email: "a@b.com", role: "USER" } });
    await firstValueFrom(interceptor.intercept(context, makeHandler()));
    const logged = JSON.parse(logSpy.mock.calls[0]?.[0] as string) as Record<string, unknown>;
    expect(logged.userId).toBe("user-42");
  });

  it("still logs on error path", async () => {
    const { context } = makeContext();
    await firstValueFrom(interceptor.intercept(context, makeErrorHandler(new Error("boom")))).catch(
      () => undefined,
    );
    expect(logSpy).toHaveBeenCalledTimes(1);
  });

  it("passes data through unchanged", async () => {
    const payload = { id: "1", name: "test" };
    const { context } = makeContext();
    const result = await firstValueFrom(interceptor.intercept(context, makeHandler(payload)));
    expect(result).toEqual(payload);
  });

  it("still logs when a downstream interceptor answers the request itself", async () => {
    // An interceptor may complete without emitting — `IdempotencyInterceptor`
    // does exactly that when it replays a stored response. There is no `next`
    // and no `error`, so a `tap`-based log would leave the request out of the
    // access log entirely.
    const { context } = makeContext();

    await lastValueFrom(interceptor.intercept(context, { handle: () => EMPTY } as CallHandler), {
      defaultValue: undefined,
    });

    expect(logSpy).toHaveBeenCalledTimes(1);
    const logged = JSON.parse(logSpy.mock.calls[0]?.[0] as string) as Record<string, unknown>;
    expect(logged.statusCode).toBe(200);
  });

  /**
   * Log-trace correlation, which is the whole point of the two extra fields.
   *
   * They are spelled in snake_case, unlike everything else in the line: the
   * names belong to the OpenTelemetry logs data model, and a collector
   * scraping stdout joins a line to its trace by finding exactly these keys.
   */
  describe("trace correlation", () => {
    it("reports null ids when nothing is being traced", async () => {
      const { context } = makeContext();

      await firstValueFrom(interceptor.intercept(context, makeHandler()));

      const logged = JSON.parse(logSpy.mock.calls[0]?.[0] as string) as Record<string, unknown>;
      expect(logged["trace_id"]).toBeNull();
      expect(logged["span_id"]).toBeNull();
    });

    describe("with an SDK installed", () => {
      let probe: TelemetryProbe;

      beforeEach(() => {
        probe = installInMemoryTelemetry();
      });

      afterEach(async () => {
        await probe.shutdown();
      });

      it("names the span the line describes", async () => {
        const { context } = makeContext();

        const span = trace.getTracer("spec").startSpan("GET /v1/users");
        await otelContext.with(trace.setSpan(otelContext.active(), span), () =>
          firstValueFrom(interceptor.intercept(context, makeHandler())),
        );
        span.end();

        const logged = JSON.parse(logSpy.mock.calls[0]?.[0] as string) as Record<string, unknown>;
        expect(logged["trace_id"]).toBe(span.spanContext().traceId);
        expect(logged["span_id"]).toBe(span.spanContext().spanId);
      });

      /**
       * The join in the other direction: an operator holding an
       * `x-correlation-id` out of a client's bug report can find the trace.
       * The attribute goes on the HTTP instrumentation's server span rather
       * than on a second span of this interceptor's own — one request, one
       * span, and nothing that would double every trace's depth.
       */
      it("puts the correlation id on the request's existing span", async () => {
        const { context } = makeContext({ correlationId: "corr-42" });

        await trace.getTracer("spec").startActiveSpan("GET /v1/users", async (span) => {
          await firstValueFrom(interceptor.intercept(context, makeHandler()));
          span.end();
        });

        expect(probe.spans()[0]?.attributes[CORRELATION_ID_ATTRIBUTE]).toBe("corr-42");
      });
    });
  });
});
