import {
  LoggingInterceptor,
  CORRELATION_ID_ATTRIBUTE,
  CORRELATION_ID_HEADER,
  splitTarget,
} from "./logging.interceptor";
import type { ExecutionContext, CallHandler } from "@nestjs/common";
import { Logger } from "@nestjs/common";
import { EMPTY, of, throwError, firstValueFrom, lastValueFrom } from "rxjs";
import { context as otelContext, trace } from "@opentelemetry/api";
import { installInMemoryTelemetry, type TelemetryProbe } from "@/test-utils/in-memory-telemetry";

function makeContext(overrides?: {
  correlationId?: string;
  user?: { id: string; email: string; role: string };
  url?: string;
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
        url: overrides?.url ?? "/v1/users",
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

/**
 * The fields of the single access-log call.
 *
 * The interceptor hands the logger an object rather than a serialised string,
 * which is what makes the line redactable: a processor chain that walks fields
 * cannot see inside a string. So this reads the argument directly instead of
 * parsing it.
 */
function loggedFields(logSpy: jest.SpyInstance): Record<string, unknown> {
  return logSpy.mock.calls[0]?.[0] as Record<string, unknown>;
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
    const logged = loggedFields(logSpy);
    expect(logged.method).toBe("GET");
    expect(logged.path).toBe("/v1/users");
    expect(logged.statusCode).toBe(200);
    expect(typeof logged.latencyMs).toBe("number");
    expect(logged.userId).toBeNull();
  });

  it("logs userId when the request carries an authenticated user", async () => {
    const { context } = makeContext({ user: { id: "user-42", email: "a@b.com", role: "USER" } });
    await firstValueFrom(interceptor.intercept(context, makeHandler()));
    const logged = loggedFields(logSpy);
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
    const logged = loggedFields(logSpy);
    expect(logged.statusCode).toBe(200);
  });

  /**
   * The defect this replaced. `req.url` is the request *target*, query string
   * included, and it was logged whole as `path` — so
   * `GET /v1/auth/google/callback?code=…` wrote a single-use OAuth
   * authorisation code, exchangeable for that person's access and refresh
   * tokens, to stdout and to the logs pipeline on every successful Google
   * sign-in.
   *
   * As one string it could only be kept or dropped. Split into named
   * parameters it becomes a set of fields the allowlist decides on
   * individually, which is what lets `query.page` survive while `query.code`
   * does not — without anyone having had to predict `code`.
   */
  describe("the request target", () => {
    it("logs the path without its query string", async () => {
      const { context } = makeContext({ url: "/v1/users?page=2&limit=50" });

      await firstValueFrom(interceptor.intercept(context, makeHandler()));

      expect(loggedFields(logSpy)["path"]).toBe("/v1/users");
    });

    it("logs the query parameters as named fields", async () => {
      const { context } = makeContext({ url: "/v1/users?page=2&limit=50" });

      await firstValueFrom(interceptor.intercept(context, makeHandler()));

      expect(loggedFields(logSpy)["query"]).toEqual({ page: "2", limit: "50" });
    });

    it("separates the OAuth authorisation code into a field the allowlist redacts", async () => {
      const { context } = makeContext({
        url: "/v1/auth/google/callback?code=4%2F0AXhV9kcQr7Tg&scope=email+profile",
      });

      await firstValueFrom(interceptor.intercept(context, makeHandler()));

      const logged = loggedFields(logSpy);
      expect(logged["path"]).toBe("/v1/auth/google/callback");
      // Decoded, and still a field rather than part of the path — so
      // `DEFAULT_ALLOWLIST`, which names no query parameter but the pagination
      // ones, replaces it. The end-to-end proof is in `test/log-redaction.e2e-spec.ts`.
      expect(logged["query"]).toEqual({ code: "4/0AXhV9kcQr7Tg", scope: "email profile" });
    });

    it("reports an empty query object when there is no query string", async () => {
      const { context } = makeContext({ url: "/v1/users" });

      await firstValueFrom(interceptor.intercept(context, makeHandler()));

      expect(loggedFields(logSpy)["query"]).toEqual({});
    });
  });

  describe("splitTarget", () => {
    it.each([
      ["/v1/users", "/v1/users", {}],
      ["/v1/users?", "/v1/users", {}],
      ["/v1/users?page=2", "/v1/users", { page: "2" }],
      ["/v1/users?flag", "/v1/users", { flag: "" }],
      ["/v1/users?a=", "/v1/users", { a: "" }],
      ["/v1/users?a=1&&b=2", "/v1/users", { a: "1", b: "2" }],
      ["/v1/users?a=b=c", "/v1/users", { a: "b=c" }],
      ["/v1/users?q=%20spaced", "/v1/users", { q: " spaced" }],
      ["/v1/users?q=a+b", "/v1/users", { q: "a b" }],
      // A `#` is not special in an origin-form target: it is a legal byte in a
      // query value and there is no fragment to separate.
      ["/v1/users?q=a#b", "/v1/users", { q: "a#b" }],
    ])("parses %s", (target, path, query) => {
      expect(splitTarget(target)).toEqual({ path, query });
    });

    it("keeps every value of a repeated parameter", () => {
      expect(splitTarget("/v1/users?tag=a&tag=b&tag=c").query).toEqual({
        tag: ["a", "b", "c"],
      });
    });

    /**
     * `decodeURIComponent` throws `URIError` on a lone `%`, which a caller can
     * send deliberately. Thrown from inside the access log it would cost the
     * line that records the request happened, so the raw form is kept instead —
     * and redacted like any other value.
     */
    it("keeps a malformed escape rather than throwing", () => {
      expect(splitTarget("/v1/users?q=100%").query).toEqual({ q: "100%" });
    });

    it("survives a malformed key as well as a malformed value", () => {
      expect(() => splitTarget("/v1/users?%=x")).not.toThrow();
    });
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

      const logged = loggedFields(logSpy);
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

        const logged = loggedFields(logSpy);
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
