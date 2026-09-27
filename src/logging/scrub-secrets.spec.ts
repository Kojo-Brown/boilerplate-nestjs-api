import { REDACTED } from "./log-event";
import { MAX_STRING_LENGTH, scrubSecrets } from "./scrub-secrets";

describe("scrubSecrets", () => {
  describe("query strings", () => {
    /**
     * The leak this module was written for. `LoggingInterceptor` logged
     * `req.url`, and the Google callback's `code` is a single-use
     * authorisation code exchangeable for that person's access and refresh
     * tokens — written to stdout on every successful sign-in.
     */
    it("removes an OAuth authorisation code while keeping the parameter name", () => {
      const scrubbed = scrubSecrets(
        "/v1/auth/google/callback?code=4/0AXhV9kcQr7TgN2mPwL&scope=email%20profile",
      );
      expect(scrubbed).toBe(`/v1/auth/google/callback?code=${REDACTED}&scope=${REDACTED}`);
      expect(scrubbed).not.toContain("4/0AXhV9kcQr7TgN2mPwL");
    });

    it("keeps the path in front of the query", () => {
      expect(scrubSecrets("/v1/users?page=2")).toBe(`/v1/users?page=${REDACTED}`);
    });

    it("scrubs every parameter, not just the first", () => {
      const scrubbed = scrubSecrets("/x?a=one&b=two&c=three");
      expect(scrubbed).toBe(`/x?a=${REDACTED}&b=${REDACTED}&c=${REDACTED}`);
    });

    it("scrubs a fragment parameter, where an implicit-flow token arrives", () => {
      expect(scrubSecrets("/cb#access_token=ya29.secret")).toBe(`/cb#access_token=${REDACTED}`);
    });

    it("leaves a string with no query string alone", () => {
      expect(scrubSecrets("/v1/users/7f3c")).toBe("/v1/users/7f3c");
    });

    /**
     * A URL inside a sentence is the usual way a signed URL reaches a log: a
     * client library interpolates the target into the message it throws.
     */
    it("scrubs a URL embedded in free text", () => {
      expect(scrubSecrets("GET https://s3/a?X-Amz-Signature=deadbeef failed")).toBe(
        `GET https://s3/a?X-Amz-Signature=${REDACTED} failed`,
      );
    });
  });

  describe("bearer credentials", () => {
    it("removes a JWT and keeps nothing of it", () => {
      const jwt =
        "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NSJ9.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1g";
      const scrubbed = scrubSecrets(`token ${jwt} rejected`);
      expect(scrubbed).toBe(`token ${REDACTED} rejected`);
      expect(scrubbed).not.toContain("eyJ");
    });

    it("keeps the scheme and drops the material after it", () => {
      expect(scrubSecrets("Authorization: Bearer abcdef0123456789")).toBe(
        `Authorization: Bearer ${REDACTED}`,
      );
    });

    it("keeps a Basic scheme, which is diagnostic, and not its credentials", () => {
      expect(scrubSecrets("got Basic dXNlcjpwYXNzd29yZA==")).toBe(`got Basic ${REDACTED}`);
    });

    /**
     * Precision matters more than reach here: a pattern that fired on ordinary
     * dotted text would redact stack frames and version strings, and a log
     * nobody can read gets the whole mechanism switched off.
     */
    it.each([
      "at Object.<anonymous> (/app/src/main.ts:12:5)",
      "upgraded @nestjs/core 11.1.27 to 11.2.0",
      "state machine moved a.b.c to d.e.f",
    ])("leaves ordinary dotted text alone: %s", (text) => {
      expect(scrubSecrets(text)).toBe(text);
    });
  });

  describe("PEM blocks", () => {
    it("collapses a private key to its header", () => {
      const pem = [
        "-----BEGIN RSA PRIVATE KEY-----",
        "MIIEowIBAAKCAQEAxLmNq3vT9wZ1p",
        "8kQ2rL0mNvB7cX4sD1fG6hJ9kL2mN",
        "-----END RSA PRIVATE KEY-----",
      ].join("\n");
      const scrubbed = scrubSecrets(`failed to load ${pem}`);
      expect(scrubbed).toBe(`failed to load -----BEGIN RSA PRIVATE KEY----- ${REDACTED}`);
      expect(scrubbed).not.toContain("MIIEowIBAAKCAQEAxLmNq3vT9wZ1p");
    });

    it("leaves a certificate alone, which is public by construction", () => {
      const cert = "-----BEGIN CERTIFICATE-----\nMIIBkTCB+wIBADANBg\n-----END CERTIFICATE-----";
      expect(scrubSecrets(cert)).toBe(cert);
    });
  });

  describe("length", () => {
    it("cuts a long string and says so", () => {
      const scrubbed = scrubSecrets("a".repeat(MAX_STRING_LENGTH + 500));
      expect(scrubbed).toHaveLength(MAX_STRING_LENGTH + 1 + REDACTED.length);
      expect(scrubbed.endsWith(`…${REDACTED}`)).toBe(true);
    });

    /**
     * The cap is applied after scrubbing, not before. Cutting first would leave
     * a credential past the boundary in the output of a function whose whole
     * job is to remove it.
     */
    it("removes a credential that sits beyond the length cap", () => {
      const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiI5OTkifQ.Zm9vYmFyYmF6";
      const scrubbed = scrubSecrets(`${"padding ".repeat(400)}${jwt}`);
      expect(scrubbed).not.toContain("eyJ");
    });

    it("leaves a short string at its own length", () => {
      expect(scrubSecrets("done")).toBe("done");
    });
  });
});
