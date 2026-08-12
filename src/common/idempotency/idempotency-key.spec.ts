import type { Request } from "express";
import {
  MAX_KEY_LENGTH,
  callerScope,
  fingerprint,
  isReplayableMethod,
  isValidKey,
  storeKey,
} from "./idempotency-key";

function makeRequest(overrides: Partial<Request> = {}): Request {
  return {
    method: "POST",
    originalUrl: "/v1/users/u1",
    headers: { "content-type": "application/json" },
    body: { name: "Ada" },
    ip: "203.0.113.4",
    ...overrides,
  } as unknown as Request;
}

describe("isReplayableMethod", () => {
  it.each(["POST", "PUT", "PATCH", "DELETE", "post", "patch"])("honours %s", (method) => {
    expect(isReplayableMethod(method)).toBe(true);
  });

  it.each(["GET", "HEAD", "OPTIONS"])("ignores %s", (method) => {
    // Already idempotent by definition. Recording them would add a Redis round
    // trip and a second cache with none of the safety.
    expect(isReplayableMethod(method)).toBe(false);
  });
});

describe("isValidKey", () => {
  it("accepts a UUID", () => {
    expect(isValidKey("6f1c0b2e-0f5f-4d3a-9b2a-6a2c1d9e7f10")).toBe(true);
  });

  it("accepts the longest allowed key and rejects one character more", () => {
    expect(isValidKey("k".repeat(MAX_KEY_LENGTH))).toBe(true);
    expect(isValidKey("k".repeat(MAX_KEY_LENGTH + 1))).toBe(false);
  });

  it.each([
    ["empty", ""],
    ["whitespace only", "   "],
    ["a newline", "abc\ndef"],
    ["a carriage return", "abc\rdef"],
    ["a NUL", "abc\0def"],
    ["a tab", "abc\tdef"],
    ["non-ASCII", "clé-idempotence"],
  ])("rejects %s", (_why, key) => {
    // Keys reach a Redis key and a log line. A key containing CRLF is a
    // log-injection primitive, so these are refused rather than escaped —
    // no legitimate client needs them.
    expect(isValidKey(key)).toBe(false);
  });
});

describe("callerScope", () => {
  it("scopes an authenticated request to its user", () => {
    const req = makeRequest({ user: { id: "u1" } } as Partial<Request>);

    expect(callerScope(req)).toBe("user:u1");
  });

  it("falls back to the client address when there is no user", () => {
    expect(callerScope(makeRequest())).toBe("ip:203.0.113.4");
  });

  it("never lets one caller's key reach another's record", () => {
    // The reason scoping exists at all: a global namespace would let anyone
    // replay someone else's response by guessing their key, and the response
    // body is exactly the thing worth stealing.
    const mine = storeKey(
      callerScope(makeRequest({ user: { id: "u1" } } as Partial<Request>)),
      "k",
    );
    const theirs = storeKey(
      callerScope(makeRequest({ user: { id: "u2" } } as Partial<Request>)),
      "k",
    );

    expect(mine).not.toBe(theirs);
  });
});

describe("fingerprint", () => {
  it("is stable across identical requests", () => {
    expect(fingerprint(makeRequest())).toBe(fingerprint(makeRequest()));
  });

  it("ignores the order the client serialised its body in", () => {
    // A retry assembled from a map may emit its fields in a different order.
    // That is the same request, and treating it as a different one would 422
    // every honest client that uses one.
    const first = makeRequest({ body: { name: "Ada", role: "ADMIN" } });
    const second = makeRequest({ body: { role: "ADMIN", name: "Ada" } });

    expect(fingerprint(first)).toBe(fingerprint(second));
  });

  it("looks inside nested objects and arrays", () => {
    const first = makeRequest({ body: { tags: [{ a: 1, b: 2 }] } });
    const second = makeRequest({ body: { tags: [{ b: 2, a: 1 }] } });
    const third = makeRequest({ body: { tags: [{ a: 1, b: 3 }] } });

    expect(fingerprint(first)).toBe(fingerprint(second));
    expect(fingerprint(first)).not.toBe(fingerprint(third));
  });

  it.each([
    ["the body", makeRequest({ body: { name: "Grace" } })],
    ["the method", makeRequest({ method: "DELETE" })],
    ["the path", makeRequest({ originalUrl: "/v1/users/u2" })],
    ["the query string", makeRequest({ originalUrl: "/v1/users/u1?force=true" })],
    ["the content type", makeRequest({ headers: { "content-type": "text/plain" } })],
    [
      "the declared length",
      makeRequest({ headers: { "content-type": "application/json", "content-length": "99" } }),
    ],
  ])("changes with %s", (_what, req) => {
    expect(fingerprint(req)).not.toBe(fingerprint(makeRequest()));
  });

  it("copes with a body-less request", () => {
    expect(fingerprint(makeRequest({ body: undefined }))).toEqual(expect.any(String));
    expect(fingerprint(makeRequest({ body: undefined }))).toBe(
      fingerprint(makeRequest({ body: null })),
    );
  });
});
