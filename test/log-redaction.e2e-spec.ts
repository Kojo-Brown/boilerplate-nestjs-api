import request from "supertest";
import type { Server } from "http";
import { REDACTED } from "@/logging";
import { TelemetryLogger } from "@/telemetry";
import { fakeJwt } from "@/test-utils/fake-jwt";
import { installInMemoryTelemetry, type TelemetryProbe } from "@/test-utils/in-memory-telemetry";
import { createTestApp, type TestApp } from "./helpers/create-test-app";

/**
 * Redaction observed where it actually has to hold: over a real router, on a
 * real request, through the logger the application installs.
 *
 * Every unit spec in `src/logging` asserts one function's behaviour, and none of
 * them can catch the failure that matters most here — a leak that happens
 * because the interceptor, the logger and the allowlist were each correct and
 * were not connected to one another. The access log is written from inside
 * `finalize`, by an interceptor Nest binds globally, through whatever
 * `app.useLogger` installed; the only way to know the chain runs on that path is
 * to send a request and read both sinks.
 *
 * "Both sinks" is the other reason. The unredacted copy this would have missed
 * is the stdout one — the copy an operator reads, the copy that is scraped into
 * whatever the cluster retains, and the copy that exists when the collector does
 * not.
 */
describe("PII redaction (e2e)", () => {
  let testApp: TestApp;
  let server: Server;
  let probe: TelemetryProbe;
  let stdout: jest.SpyInstance;

  /** Everything written to stdout since the spy was installed. */
  const stdoutText = (): string => stdout.mock.calls.map((call) => String(call[0])).join("");

  /** The access-log record, found by its message rather than by position. */
  const accessLog = () =>
    probe.logRecords().find((record) => String(record.body) === "request")?.attributes ?? {};

  beforeAll(async () => {
    testApp = await createTestApp();
    server = testApp.app.getHttpServer() as Server;
  });

  afterAll(async () => {
    await testApp.app.close();
  });

  beforeEach(() => {
    probe = installInMemoryTelemetry();
    stdout = jest.spyOn(process.stdout, "write").mockReturnValue(true);
    // The logger under test, installed the way `main.ts` installs it. After
    // `createTestApp` rather than inside it, so every other e2e suite keeps
    // Nest's default logger and this one does not have to reason about output it
    // did not cause.
    testApp.app.useLogger(new TelemetryLogger());
  });

  afterEach(async () => {
    stdout.mockRestore();
    await probe.shutdown();
  });

  /**
   * The defect, end to end, on a route that is actually access-logged.
   *
   * The leak was `path: req.url` — the request *target*, query string included —
   * so `GET /v1/auth/google/callback?code=…` wrote a single-use OAuth
   * authorisation code, exchangeable for that person's access and refresh
   * tokens, to stdout and to the logs pipeline on every successful sign-in.
   *
   * The assertion is made against `/v1/health` carrying the same parameter,
   * and that substitution is deliberate rather than convenient. Nest runs
   * **guards before interceptors**, so a request `GoogleAuthGuard` refuses never
   * reaches `LoggingInterceptor` and produces no access-log line at all — which
   * means a spec pointed at the callback would pass whatever this module did,
   * because nothing would be logged either way. The leak was on the path where
   * the guard *succeeds*, and `/v1/health` is the unguarded route that reaches
   * the interceptor the same way a successful callback does. Redaction is
   * decided per parameter name and per field path, with no knowledge of the
   * route, so this exercises exactly the code the callback would.
   *
   * (That guards are not access-logged at all is its own gap. It is not this
   * item's, and it is written up in `docs/log-redaction.md`.)
   */
  it("does not write an OAuth authorisation code to either sink", async () => {
    const code = "4/0AXhV9kcQr7TgN2mPwLsecret";

    await request(server).get(`/v1/health?code=${encodeURIComponent(code)}`);

    // The line exists — otherwise this would pass vacuously, which is the trap
    // the comment above describes.
    expect(accessLog()["path"]).toBe("/v1/health");
    expect(stdoutText()).not.toContain(code);
    expect(JSON.stringify(accessLog())).not.toContain(code);
  });

  it("records that the code parameter arrived, without its value", async () => {
    await request(server).get("/v1/health?code=4%2F0AXsecret&state=xyz789");

    const logged = accessLog();
    // The path survives, which is the whole reason `path` is allowlisted.
    expect(logged["path"]).toBe("/v1/health");
    // And the parameters are named but not valued: an operator can see that a
    // callback arrived carrying a code and a state, which is what they need, and
    // cannot read either, which is what they must not.
    expect(logged["query"]).toBe(`{"code":"${REDACTED}","state":"${REDACTED}"}`);
  });

  it("keeps the pagination parameters it allowlisted by name", async () => {
    await request(server).get("/v1/health?page=1&limit=10");

    expect(accessLog()["query"]).toBe('{"page":"1","limit":"10"}');
  });

  /**
   * The property that makes the allowlist worth the friction: a parameter nobody
   * anticipated is redacted on the first request that carries it, with no
   * pattern having had to describe it and no denylist having had to name it.
   */
  it("redacts a query parameter nothing in the codebase has heard of", async () => {
    await request(server).get("/v1/health?national_insurance_number=QQ123456C");

    expect(stdoutText()).not.toContain("QQ123456C");
    expect(accessLog()["query"]).toBe(`{"national_insurance_number":"${REDACTED}"}`);
  });

  it("keeps the fields the access log exists for", async () => {
    await request(server).get("/v1/health");

    const logged = accessLog();
    expect(logged["method"]).toBe("GET");
    expect(logged["path"]).toBe("/v1/health");
    expect(logged["statusCode"]).toBe(200);
    expect(typeof logged["latencyMs"]).toBe("number");
    expect(typeof logged["correlationId"]).toBe("string");
  });

  /**
   * A request body is not logged by this service at all, and this asserts the
   * absence rather than trusting it: a body is the largest concentration of
   * personal data in an HTTP request, and the usual way it reaches a log is an
   * access-log line that grew a `body` field because somebody was debugging.
   * If that field ever appears, it arrives redacted — and this spec fails,
   * which is the intended prompt to think about it.
   */
  it("does not log a request body", async () => {
    await request(server)
      .post("/v1/auth/login")
      .send({ email: "ada@example.com", password: "not-the-real-password" });

    expect(stdoutText()).not.toContain("ada@example.com");
    expect(stdoutText()).not.toContain("not-the-real-password");
    expect(Object.keys(accessLog())).not.toContain("body");
  });

  /**
   * The `Authorization` header, for the same reason: headers are not logged, and
   * a bearer token is the single most damaging thing to write down, because it
   * is replayable by whoever reads the line.
   */
  it("does not log an Authorization header", async () => {
    const token = fakeJwt("u-1");

    await request(server).get("/v1/auth/me").set("Authorization", `Bearer ${token}`);

    expect(stdoutText()).not.toContain(token);
    expect(JSON.stringify(accessLog())).not.toContain(token);
  });

  it("writes the access log as one line, so a field cannot split the stream", async () => {
    await request(server).get("/v1/health");

    const requestLines = stdoutText()
      .split("\n")
      .filter((line) => line.includes('"path":"/v1/health"'));
    expect(requestLines).toHaveLength(1);
  });
});
