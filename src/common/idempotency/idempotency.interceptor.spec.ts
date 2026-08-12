import { EventEmitter } from "node:events";
import { HttpException, HttpStatus, Logger } from "@nestjs/common";
import { firstValueFrom, lastValueFrom, of } from "rxjs";
import type { CallHandler, ExecutionContext } from "@nestjs/common";
import type { Request, Response } from "express";
import { IdempotencyInterceptor } from "./idempotency.interceptor";
import { InMemoryIdempotencyStore } from "./stores/in-memory-idempotency.store";
import { IDEMPOTENCY_REPLAYED_HEADER } from "./idempotency-key";
import { stubConfig } from "@/test-utils/stub-config";
import type { IdempotencyStore } from "./ports";

const TTL_SECONDS = 60;

/**
 * Enough of an Express response to exercise the capture path: a status, mutable
 * headers, a `send` that ends the response, and the `finish`/`close` events the
 * interceptor hangs its recording off.
 *
 * Written out rather than mocked because the interesting behaviour is the order
 * these fire in — `send` before `finish`, `close` without `finish` on an abort —
 * and a mock that returned canned values would prove nothing about it.
 */
class FakeResponse extends EventEmitter {
  statusCode = 200;

  readonly headers: Record<string, string> = {};

  sent: unknown;

  status(code: number): this {
    this.statusCode = code;
    return this;
  }

  setHeader(name: string, value: string): this {
    this.headers[name.toLowerCase()] = value;
    return this;
  }

  getHeader(name: string): string | undefined {
    return this.headers[name.toLowerCase()];
  }

  send(payload?: unknown): this {
    // Express serialises objects through `res.json`, which re-enters `send`
    // with the string. Reproduced here because the interceptor depends on the
    // last call being the one that carries the bytes.
    if (payload !== undefined && payload !== null && typeof payload !== "string") {
      this.setHeader("content-type", "application/json; charset=utf-8");
      return this.send(JSON.stringify(payload));
    }

    this.sent = payload ?? null;
    this.emit("finish");
    return this;
  }

  end(): this {
    this.sent = null;
    this.emit("finish");
    return this;
  }

  /** A client that hung up before the response was written. */
  abort(): void {
    this.emit("close");
  }
}

function makeContext(
  req: Partial<Request>,
  res: FakeResponse,
): { context: ExecutionContext; res: FakeResponse } {
  const request = {
    method: "POST",
    originalUrl: "/v1/users",
    headers: {},
    body: { name: "Ada" },
    ip: "203.0.113.4",
    ...req,
  } as unknown as Request;

  const context = {
    getType: () => "http",
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => res as unknown as Response,
    }),
  } as unknown as ExecutionContext;

  return { context, res };
}

/** Runs the handler the way Nest does: subscribe, then let the response finish. */
function handlerReturning(value: unknown, res: FakeResponse, status = 201): CallHandler {
  return {
    handle: () => {
      res.status(status).send(value);
      return of(value);
    },
  } as CallHandler;
}

/** Lets every `void this.…()` the interceptor fires settle before asserting. */
function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/** The HTTP status a call was refused with, or `undefined` if it was not. */
async function rejectionStatus(promise: Promise<unknown>): Promise<number | undefined> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return error instanceof HttpException ? error.getStatus() : undefined;
  }
}

describe("IdempotencyInterceptor", () => {
  const KEY = "6f1c0b2e-0f5f-4d3a-9b2a-6a2c1d9e7f10";

  let store: InMemoryIdempotencyStore;
  let interceptor: IdempotencyInterceptor;

  beforeEach(() => {
    store = new InMemoryIdempotencyStore();
    interceptor = new IdempotencyInterceptor(
      store,
      stubConfig({ IDEMPOTENCY_TTL_SECONDS: TTL_SECONDS }),
    );
  });

  describe("when the client does not opt in", () => {
    it("passes a request with no Idempotency-Key straight through", async () => {
      const res = new FakeResponse();
      const { context } = makeContext({}, res);

      await firstValueFrom(await interceptor.intercept(context, handlerReturning("ok", res)));

      expect(await store.get("ip:203.0.113.4:" + KEY)).toBeNull();
    });

    it("ignores the header on a method that is already idempotent", async () => {
      // A GET carrying the header is not an error, it is just nothing to do —
      // and recording it would shadow the HTTP cache with a second, weaker one.
      const res = new FakeResponse();
      const { context } = makeContext({ method: "GET", headers: { "idempotency-key": KEY } }, res);

      await firstValueFrom(await interceptor.intercept(context, handlerReturning("ok", res)));

      expect(await store.get("ip:203.0.113.4:" + KEY)).toBeNull();
    });
  });

  describe("key validation", () => {
    it("refuses a header sent twice, because there is no way to tell which key was meant", async () => {
      const res = new FakeResponse();
      const { context } = makeContext({ headers: { "idempotency-key": [KEY, "other"] } }, res);

      await expect(interceptor.intercept(context, handlerReturning("ok", res))).rejects.toThrow(
        /exactly once/,
      );
    });

    it.each([
      ["blank", "   "],
      ["over-long", "k".repeat(256)],
      ["carrying a newline", "abc\ndef"],
      ["non-ASCII", "clé"],
    ])("refuses a %s key with 400", async (_why, key) => {
      const res = new FakeResponse();
      const { context } = makeContext({ headers: { "idempotency-key": key } }, res);

      expect(
        await rejectionStatus(interceptor.intercept(context, handlerReturning("ok", res))),
      ).toBe(HttpStatus.BAD_REQUEST);
    });
  });

  describe("the first request", () => {
    it("runs the handler and records what the client received", async () => {
      const res = new FakeResponse();
      const { context } = makeContext({ headers: { "idempotency-key": KEY } }, res);

      await firstValueFrom(
        await interceptor.intercept(context, handlerReturning({ id: "u1" }, res)),
      );
      await flush();

      const record = await store.get(`ip:203.0.113.4:${KEY}`);
      expect(record).toMatchObject({
        state: "completed",
        response: {
          status: 201,
          contentType: "application/json; charset=utf-8",
          body: '{"id":"u1"}',
        },
      });
    });

    it("records a body-less response as one", async () => {
      const res = new FakeResponse();
      const { context } = makeContext(
        { method: "DELETE", headers: { "idempotency-key": KEY } },
        res,
      );

      await firstValueFrom(
        await interceptor.intercept(context, {
          // What Nest's Express adapter does with a nil handler result: it
          // calls `res.send()` with no argument rather than `res.end()`.
          handle: () => {
            res.status(204).send();
            return of(undefined);
          },
        } as CallHandler),
      );
      await flush();

      const record = await store.get(`ip:203.0.113.4:${KEY}`);
      expect(record?.state === "completed" && record.response).toEqual({
        status: 204,
        contentType: null,
        body: null,
      });
    });

    it("scopes the record to the authenticated user", async () => {
      const res = new FakeResponse();
      const { context } = makeContext(
        { headers: { "idempotency-key": KEY }, user: { id: "u1" } } as Partial<Request>,
        res,
      );

      await firstValueFrom(await interceptor.intercept(context, handlerReturning("ok", res)));
      await flush();

      expect(await store.get(`user:u1:${KEY}`)).not.toBeNull();
      expect(await store.get(`ip:203.0.113.4:${KEY}`)).toBeNull();
    });
  });

  describe("a retry", () => {
    async function runFirstRequest(overrides: Partial<Request> = {}): Promise<void> {
      const res = new FakeResponse();
      const { context } = makeContext({ headers: { "idempotency-key": KEY }, ...overrides }, res);
      await firstValueFrom(
        await interceptor.intercept(context, handlerReturning({ id: "u1" }, res)),
      );
      await flush();
    }

    it("replays the recorded response without running the handler again", async () => {
      await runFirstRequest();

      const res = new FakeResponse();
      const { context } = makeContext({ headers: { "idempotency-key": KEY } }, res);
      const handle = jest.fn(() => of("should not run"));

      // EMPTY completes without emitting: the response is already written, and
      // handing a value back would re-encode the recorded bytes.
      await lastValueFrom(
        await interceptor.intercept(context, { handle } as unknown as CallHandler),
        { defaultValue: undefined },
      );

      expect(handle).not.toHaveBeenCalled();
      expect(res.statusCode).toBe(201);
      expect(res.sent).toBe('{"id":"u1"}');
      expect(res.getHeader("content-type")).toBe("application/json; charset=utf-8");
      expect(res.headers[IDEMPOTENCY_REPLAYED_HEADER.toLowerCase()]).toBe("true");
    });

    it("answers 409 while the first request is still running", async () => {
      const first = new FakeResponse();
      const { context: firstContext } = makeContext({ headers: { "idempotency-key": KEY } }, first);
      // Reserve, but never let the handler finish.
      await interceptor.intercept(firstContext, { handle: () => of("slow") } as CallHandler);

      const res = new FakeResponse();
      const { context } = makeContext({ headers: { "idempotency-key": KEY } }, res);

      await expect(interceptor.intercept(context, handlerReturning("ok", res))).rejects.toThrow(
        /still being processed/,
      );
    });

    it("answers 422 when the key was used for a different request", async () => {
      await runFirstRequest();

      const res = new FakeResponse();
      const { context } = makeContext(
        { headers: { "idempotency-key": KEY }, body: { name: "Grace" } },
        res,
      );

      expect(
        await rejectionStatus(interceptor.intercept(context, handlerReturning("ok", res))),
      ).toBe(HttpStatus.UNPROCESSABLE_ENTITY);
    });

    it("does not let one caller read another's recorded response", async () => {
      await runFirstRequest({ user: { id: "u1" } } as Partial<Request>);

      const res = new FakeResponse();
      const { context } = makeContext(
        { headers: { "idempotency-key": KEY }, user: { id: "u2" } } as Partial<Request>,
        res,
      );
      const handle = jest.fn(() => of("mine"));
      await firstValueFrom(
        await interceptor.intercept(context, { handle } as unknown as CallHandler),
      );

      // u2 gets its own execution, not u1's body.
      expect(handle).toHaveBeenCalled();
    });
  });

  describe("when there is nothing worth replaying", () => {
    it("releases the key after a 5xx so the client can retry for real", async () => {
      const res = new FakeResponse();
      const { context } = makeContext({ headers: { "idempotency-key": KEY } }, res);

      await firstValueFrom(
        await interceptor.intercept(context, handlerReturning({ message: "boom" }, res, 500)),
      );
      await flush();

      expect(await store.get(`ip:203.0.113.4:${KEY}`)).toBeNull();
    });

    it("keeps a 4xx, because the same key naming the same request has the same answer", async () => {
      const res = new FakeResponse();
      const { context } = makeContext({ headers: { "idempotency-key": KEY } }, res);

      await firstValueFrom(
        await interceptor.intercept(context, handlerReturning({ message: "nope" }, res, 422)),
      );
      await flush();

      const record = await store.get(`ip:203.0.113.4:${KEY}`);
      expect(record?.state === "completed" && record.response.status).toBe(422);
    });

    it("releases the key when the client hangs up mid-request", async () => {
      const res = new FakeResponse();
      const { context } = makeContext({ headers: { "idempotency-key": KEY } }, res);

      await interceptor.intercept(context, { handle: () => of("slow") } as CallHandler);
      res.abort();
      await flush();

      expect(await store.get(`ip:203.0.113.4:${KEY}`)).toBeNull();
    });

    it("releases the key when the body never went through res.send()", async () => {
      // A streamed or piped response cannot be reproduced, so pinning the key
      // to it would answer every retry with something this module never saw.
      const debug = jest.spyOn(Logger.prototype, "debug").mockImplementation(() => undefined);
      const res = new FakeResponse();
      const { context } = makeContext({ headers: { "idempotency-key": KEY } }, res);

      await interceptor.intercept(context, { handle: () => of("streamed") } as CallHandler);
      res.emit("finish");
      await flush();

      expect(await store.get(`ip:203.0.113.4:${KEY}`)).toBeNull();
      expect(debug).toHaveBeenCalledWith(expect.stringContaining("cannot be replayed"));
      debug.mockRestore();
    });
  });

  describe("when the store is unreachable", () => {
    it("refuses the request rather than running it unprotected", async () => {
      // Fail closed. Executing anyway is how a client ends up charged twice, so
      // an unreachable store makes mutating requests unavailable, not unsafe.
      const error = jest.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
      const broken: IdempotencyStore = {
        reserve: () => Promise.reject(new Error("ECONNREFUSED")),
        complete: () => Promise.resolve(false),
        release: () => Promise.resolve(false),
        get: () => Promise.resolve(null),
      };
      const failing = new IdempotencyInterceptor(
        broken,
        stubConfig({ IDEMPOTENCY_TTL_SECONDS: TTL_SECONDS }),
      );
      const res = new FakeResponse();
      const { context } = makeContext({ headers: { "idempotency-key": KEY } }, res);

      expect(await rejectionStatus(failing.intercept(context, handlerReturning("ok", res)))).toBe(
        HttpStatus.SERVICE_UNAVAILABLE,
      );
      expect(error).toHaveBeenCalledWith(expect.stringContaining("ECONNREFUSED"));

      error.mockRestore();
    });
  });
});
