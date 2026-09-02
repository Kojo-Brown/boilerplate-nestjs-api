import type { IncomingHttpHeaders } from "http";
import { authenticateHandshake, readHandshakeCredentials } from "./handshake";
import type { HandshakeRequest, HandshakeTokenVerifier } from "./ports";

function upgrade(headers: IncomingHttpHeaders, url = "/v1/realtime"): HandshakeRequest {
  return { url, headers };
}

const validClaims = { sub: "user-1", email: "person@example.test", role: "USER" };

/** Verifies exactly one token and rejects everything else, like a signing key. */
function verifierFor(token: string, claims: unknown = validClaims): HandshakeTokenVerifier {
  return {
    verify(candidate: string): unknown {
      if (candidate !== token) throw new Error("invalid signature");
      return claims;
    },
  };
}

describe("readHandshakeCredentials", () => {
  it("reads a bearer token from the Authorization header", () => {
    const result = readHandshakeCredentials(upgrade({ authorization: "Bearer mock-access-token" }));

    expect(result).toEqual({
      ok: true,
      credentials: { token: "mock-access-token", source: "authorization-header" },
    });
  });

  it("accepts the scheme case-insensitively and tolerates surrounding whitespace", () => {
    const result = readHandshakeCredentials(upgrade({ authorization: "  bearer   mock-token  " }));

    expect(result).toMatchObject({ ok: true, credentials: { token: "mock-token" } });
  });

  it("refuses an Authorization header that is not a bearer token", () => {
    expect(readHandshakeCredentials(upgrade({ authorization: "Basic dXNlcjpwdw==" }))).toEqual({
      ok: false,
      rejection: "malformed-credentials",
    });
  });

  it("reads the browser form: Sec-WebSocket-Protocol: bearer, <token>", () => {
    const result = readHandshakeCredentials(
      upgrade({ "sec-websocket-protocol": "bearer, mock-access-token" }),
    );

    expect(result).toEqual({
      ok: true,
      credentials: { token: "mock-access-token", source: "subprotocol" },
    });
  });

  it("refuses a subprotocol offer with anything other than exactly one token after `bearer`", () => {
    // Guessing which of three values is the credential is how something that
    // was never meant to be one gets matched by position.
    for (const offered of ["bearer", "bearer, a, b", "graphql-ws", ""]) {
      expect(readHandshakeCredentials(upgrade({ "sec-websocket-protocol": offered }))).toEqual({
        ok: false,
        rejection: "malformed-credentials",
      });
    }
  });

  it("prefers the Authorization header when both are present", () => {
    const result = readHandshakeCredentials(
      upgrade({
        authorization: "Bearer from-header",
        "sec-websocket-protocol": "bearer, from-subprotocol",
      }),
    );

    expect(result).toMatchObject({ ok: true, credentials: { token: "from-header" } });
  });

  it("refuses a token in the query string, and says so specifically", () => {
    // The distinct rejection is the point: a client doing the wrong thing gets
    // a log line naming what it did, not "missing credentials".
    for (const param of ["token", "access_token", "accessToken", "jwt", "authorization"]) {
      expect(
        readHandshakeCredentials(upgrade({}, `/v1/realtime?${param}=mock-access-token`)),
      ).toEqual({ ok: false, rejection: "token-in-query" });
    }
  });

  it("reports a handshake with no credentials at all as missing", () => {
    expect(readHandshakeCredentials(upgrade({}))).toEqual({
      ok: false,
      rejection: "missing-credentials",
    });
    expect(readHandshakeCredentials(upgrade({}, "/v1/realtime?rooms=all"))).toEqual({
      ok: false,
      rejection: "missing-credentials",
    });
  });

  it("survives an upgrade request with no url", () => {
    expect(readHandshakeCredentials({ url: undefined, headers: {} })).toEqual({
      ok: false,
      rejection: "missing-credentials",
    });
  });
});

describe("authenticateHandshake", () => {
  it("builds the same principal JwtStrategy.validate builds", () => {
    const result = authenticateHandshake(
      upgrade({ authorization: "Bearer mock-access-token" }),
      verifierFor("mock-access-token"),
    );

    expect(result).toEqual({
      ok: true,
      user: { id: "user-1", email: "person@example.test", role: "USER" },
      source: "authorization-header",
    });
  });

  it("rejects a token that does not verify, without saying why", () => {
    const result = authenticateHandshake(
      upgrade({ authorization: "Bearer forged" }),
      verifierFor("mock-access-token"),
    );

    expect(result).toEqual({ ok: false, rejection: "invalid-token" });
  });

  it("rejects a token this service signed that is not an access token", () => {
    // The case the claim check exists for: `verify` only proves the signature,
    // so anything else signed with JWT_SECRET would otherwise become a
    // principal with `id: undefined`.
    for (const claims of [
      { sub: "user-1", email: "person@example.test" },
      { sub: "", email: "person@example.test", role: "USER" },
      { sub: 42, email: "person@example.test", role: "USER" },
      "a bare string",
      null,
    ]) {
      const result = authenticateHandshake(
        upgrade({ authorization: "Bearer mock-access-token" }),
        verifierFor("mock-access-token", claims),
      );

      expect(result).toEqual({ ok: false, rejection: "unexpected-claims" });
    }
  });

  it("does not call the verifier when the handshake carried no credentials", () => {
    const verify = jest.fn();

    const result = authenticateHandshake(upgrade({}), { verify });

    expect(result).toEqual({ ok: false, rejection: "missing-credentials" });
    expect(verify).not.toHaveBeenCalled();
  });

  it("is synchronous, so no unauthenticated socket exists between upgrade and close", () => {
    // Asserting on the shape rather than the timing: a `Promise` here would
    // mean the gateway's connection handler returns before it has decided, and
    // the socket can send frames in that window.
    const result: unknown = authenticateHandshake(
      upgrade({ authorization: "Bearer mock-access-token" }),
      verifierFor("mock-access-token"),
    );

    expect(result).not.toBeInstanceOf(Promise);
  });
});
