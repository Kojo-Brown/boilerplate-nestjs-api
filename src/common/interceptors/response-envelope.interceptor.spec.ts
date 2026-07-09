import { ResponseEnvelopeInterceptor } from "./response-envelope.interceptor";
import type { ExecutionContext, CallHandler } from "@nestjs/common";
import { HttpStatus } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { of, firstValueFrom } from "rxjs";

function makeContext(statusCode: number): ExecutionContext {
  return {
    getHandler: () => ({}),
    getClass: () => ({}),
    switchToHttp: () => ({
      getResponse: () => ({ statusCode }),
    }),
  } as unknown as ExecutionContext;
}

function makeHandler(data: unknown): CallHandler {
  return { handle: () => of(data) } as unknown as CallHandler;
}

type Envelope = { success: true; data: unknown; meta: { timestamp: string; version: string } };

describe("ResponseEnvelopeInterceptor", () => {
  let interceptor: ResponseEnvelopeInterceptor<unknown>;
  let reflector: Reflector;

  beforeEach(() => {
    reflector = { getAllAndOverride: jest.fn().mockReturnValue(false) } as unknown as Reflector;
    interceptor = new ResponseEnvelopeInterceptor(reflector);
  });

  it("wraps a 200 response in success envelope", async () => {
    const payload = { id: "abc", email: "user@example.com" };
    const result = (await firstValueFrom(
      interceptor.intercept(makeContext(HttpStatus.OK), makeHandler(payload)),
    )) as Envelope;

    expect(result.success).toBe(true);
    expect(result.data).toEqual(payload);
    expect(result.meta.version).toBe("v1");
    expect(() => new Date(result.meta.timestamp).toISOString()).not.toThrow();
  });

  it("wraps a 201 Created response in success envelope", async () => {
    const payload = { accessToken: "tok", refreshToken: "ref", expiresIn: 900 };
    const result = (await firstValueFrom(
      interceptor.intercept(makeContext(HttpStatus.CREATED), makeHandler(payload)),
    )) as Envelope;

    expect(result.success).toBe(true);
    expect(result.data).toEqual(payload);
  });

  it("returns undefined for 204 No Content (skips envelope)", async () => {
    const result = await firstValueFrom(
      interceptor.intercept(makeContext(HttpStatus.NO_CONTENT), makeHandler(undefined)),
    );
    expect(result).toBeUndefined();
  });

  it("meta.timestamp is a valid ISO 8601 string", async () => {
    const result = (await firstValueFrom(
      interceptor.intercept(makeContext(HttpStatus.OK), makeHandler({ ok: true })),
    )) as Envelope;

    expect(new Date(result.meta.timestamp).toISOString()).toBe(result.meta.timestamp);
  });

  it("preserves null data in envelope", async () => {
    const result = (await firstValueFrom(
      interceptor.intercept(makeContext(HttpStatus.OK), makeHandler(null)),
    )) as Envelope;

    expect(result.success).toBe(true);
    expect(result.data).toBeNull();
  });
});
