import { isRetryableStatus, isSafeMethod } from "./http-resilience";
import { parseRetryAfter } from "./json-http";

describe("parseRetryAfter", () => {
  const now = Date.parse("2026-09-08T12:00:00.000Z");

  it("reads delta-seconds", () => {
    expect(parseRetryAfter("30", now)).toBe(30_000);
    expect(parseRetryAfter(" 1 ", now)).toBe(1_000);
    expect(parseRetryAfter("0", now)).toBe(0);
  });

  it("reads an HTTP-date as a delay from now", () => {
    // RFC 9110 allows either form, and a CDN in front of a gateway is as likely
    // to send a date as the gateway is to send seconds.
    expect(parseRetryAfter("Tue, 08 Sep 2026 12:00:45 GMT", now)).toBe(45_000);
  });

  it("treats a date that has already passed as retry-now", () => {
    // Not a negative delay: an expired hint means the window has rolled over.
    expect(parseRetryAfter("Tue, 08 Sep 2026 11:59:00 GMT", now)).toBe(0);
  });

  it("returns null for an absent, empty or unparseable header", () => {
    expect(parseRetryAfter(null, now)).toBeNull();
    expect(parseRetryAfter("   ", now)).toBeNull();
    expect(parseRetryAfter("soon", now)).toBeNull();
    // A negative delta is not a delay anyone can honour.
    expect(parseRetryAfter("-5", now)).toBeNull();
  });
});

describe("isRetryableStatus", () => {
  it("counts the statuses that describe a condition which can pass", () => {
    expect(isRetryableStatus(500)).toBe(true);
    expect(isRetryableStatus(502)).toBe(true);
    expect(isRetryableStatus(503)).toBe(true);
    expect(isRetryableStatus(408)).toBe(true);
    expect(isRetryableStatus(429)).toBe(true);
  });

  it("excludes the 4xx that mean this service sent something wrong", () => {
    // Retrying any of these burns the ladder to arrive at the same answer, and
    // counting them would let a healthy dependency open its own breaker.
    expect(isRetryableStatus(400)).toBe(false);
    expect(isRetryableStatus(401)).toBe(false);
    expect(isRetryableStatus(404)).toBe(false);
    expect(isRetryableStatus(422)).toBe(false);
    expect(isRetryableStatus(200)).toBe(false);
  });
});

describe("isSafeMethod", () => {
  it("treats the RFC 9110 safe methods as replayable", () => {
    expect(isSafeMethod("GET")).toBe(true);
    expect(isSafeMethod("head")).toBe(true);
    expect(isSafeMethod("OPTIONS")).toBe(true);
    // `fetch` defaults to GET when the method is omitted, and so does this.
    expect(isSafeMethod(undefined)).toBe(true);
  });

  it("does not assume anything else is", () => {
    expect(isSafeMethod("POST")).toBe(false);
    expect(isSafeMethod("PATCH")).toBe(false);
    // PUT and DELETE are idempotent by definition, but only for a caller that
    // wrote them that way: a `PUT` that appends is a `PUT` that appends twice.
    // Those calls opt in per request instead of by method.
    expect(isSafeMethod("PUT")).toBe(false);
    expect(isSafeMethod("DELETE")).toBe(false);
  });
});
