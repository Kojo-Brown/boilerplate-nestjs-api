import { trace } from "@opentelemetry/api";
import { SeverityNumber } from "@opentelemetry/api-logs";
import { installInMemoryTelemetry, type TelemetryProbe } from "@/test-utils/in-memory-telemetry";
import { PASSTHROUGH_PROCESSORS, REDACTED } from "@/logging";
import { TelemetryLogger } from "./telemetry-logger";

describe("TelemetryLogger", () => {
  let probe: TelemetryProbe;
  let logger: TelemetryLogger;
  /**
   * The stdout half is Nest's own `ConsoleLogger`. Captured rather than
   * silenced, because "it still writes to stdout" is one of the properties
   * under test; `stderr` is captured too so `error` and `fatal` do not decorate
   * the suite's output with stack traces that are working as intended.
   */
  let written: jest.SpyInstance;
  let writtenToStderr: jest.SpyInstance;

  beforeEach(() => {
    probe = installInMemoryTelemetry();
    written = jest.spyOn(process.stdout, "write").mockReturnValue(true);
    writtenToStderr = jest.spyOn(process.stderr, "write").mockReturnValue(true);
    logger = new TelemetryLogger("Spec");
  });

  afterEach(async () => {
    written.mockRestore();
    writtenToStderr.mockRestore();
    await probe.shutdown();
  });

  it("still writes to stdout, because the pipeline is the second copy and not the only one", () => {
    logger.log("the application is listening", "Bootstrap");

    expect(written).toHaveBeenCalled();
    expect(written.mock.calls.map((call) => String(call[0])).join("")).toContain(
      "the application is listening",
    );
  });

  it("emits one log record per line, with the message as the body", () => {
    logger.log("staged user.registered", "TransactionalOutbox");

    const [record] = probe.logRecords();
    expect(record?.body).toBe("staged user.registered");
    expect(record?.severityNumber).toBe(SeverityNumber.INFO);
    expect(record?.severityText).toBe("INFO");
  });

  it.each([
    ["error", SeverityNumber.ERROR],
    ["warn", SeverityNumber.WARN],
    ["debug", SeverityNumber.DEBUG],
    ["verbose", SeverityNumber.TRACE],
    ["fatal", SeverityNumber.FATAL],
  ] as const)("maps %s onto the logs data model's severity", (level, severity) => {
    logger[level]("something happened", "Spec");

    expect(probe.logRecords()[0]?.severityNumber).toBe(severity);
  });

  /**
   * Nest passes the logger's context as the trailing argument. Left in the
   * body, every record would read `"message,OutboxRelay"` — neither the message
   * nor a field anything can group by.
   */
  it("lifts Nest's trailing context argument out of the body", () => {
    logger.warn("the relay is behind", "OutboxRelayService");

    const [record] = probe.logRecords();
    expect(record?.body).toBe("the relay is behind");
    expect(record?.attributes["log.context"]).toBe("OutboxRelayService");
  });

  /**
   * Nest's error shape is `(message, stack, context)`. The stack is named as a
   * field rather than left among the positional arguments, which is what lets
   * the allowlist admit it — see `DEFAULT_ALLOWLIST` on why a stack is
   * allowlisted and `extra` is not.
   */
  it("keeps an error's stack rather than dropping it", () => {
    const failure = new Error("broker unreachable");

    logger.error("publish failed", failure.stack, "BrokerOutboxPublisher");

    const [record] = probe.logRecords();
    expect(record?.attributes["log.context"]).toBe("BrokerOutboxPublisher");
    expect(String(record?.attributes["stack"])).toContain("broker unreachable");
  });

  /**
   * An object in the message slot is the structured call: its keys become fields,
   * where the allowlist can reason about them, and `message` is lifted out as the
   * body. This is the form worth writing — a value passed this way is a value the
   * redactor can see, unlike one interpolated into a string.
   */
  it("reads an object message as fields rather than serialising it into the body", () => {
    logger.log({ message: "user registered", userId: "user-1", eventType: "user.registered" });

    const [record] = probe.logRecords();
    expect(record?.body).toBe("user registered");
    expect(record?.attributes["userId"]).toBe("user-1");
    expect(record?.attributes["eventType"]).toBe("user.registered");
  });

  it("survives a message that cannot be serialised", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic["self"] = cyclic;

    expect(() => logger.log(cyclic)).not.toThrow();
    expect(probe.logRecords()).toHaveLength(1);
  });

  describe("redaction", () => {
    /**
     * The property that makes this seam the right place for redaction: there is
     * one, and everything goes through it. `new Logger()` anywhere in the
     * application delegates to whatever `app.useLogger` installed.
     */
    it("redacts a field the allowlist does not admit", () => {
      logger.log({ message: "request", userId: "u-1", customerEmail: "ada@example.com" });

      const [record] = probe.logRecords();
      expect(record?.attributes["userId"]).toBe("u-1");
      expect(record?.attributes["customerEmail"]).toBe(REDACTED);
    });

    /**
     * The failure this ordering exists to prevent. Redacting only the
     * OpenTelemetry record would leave the stdout copy — the one an operator
     * reads with `kubectl logs`, the one that is scraped into whatever the
     * cluster keeps, and the copy that exists even when the collector is
     * unreachable — in the clear. Two sinks with two ideas of what is sensitive
     * is the same as no redaction, and harder to notice, because the pipeline an
     * auditor is shown looks correct.
     */
    it("redacts the stdout copy too, not only the pipeline", () => {
      logger.log({ message: "request", customerEmail: "ada@example.com" });

      const stdout = written.mock.calls.map((call) => String(call[0])).join("");
      expect(stdout).not.toContain("ada@example.com");
      expect(stdout).toContain(REDACTED);
    });

    it("scrubs a credential out of the free-text message on both sinks", () => {
      logger.warn("callback failed for /cb?code=4/0AXsecretvalue", "AuthController");

      expect(probe.logRecords()[0]?.body).toBe(`callback failed for /cb?code=${REDACTED}`);
      expect(written.mock.calls.map((call) => String(call[0])).join("")).not.toContain(
        "4/0AXsecretvalue",
      );
    });

    it("writes one line per record, so a field cannot split the stream", () => {
      logger.log({ message: "request", path: "/v1/users", statusCode: 200 });

      const stdout = written.mock.calls.map((call) => String(call[0])).join("");
      expect(stdout.trimEnd().split("\n")).toHaveLength(1);
    });

    /**
     * A chain handed in explicitly, which is how a deployment running with
     * `LOG_REDACTION_ENABLED=false` behaves. Exercised so the disabled path
     * cannot rot into one that crashes the only time anybody uses it.
     */
    it("writes the record unchanged through an empty chain", () => {
      const unredacted = new TelemetryLogger("Spec", PASSTHROUGH_PROCESSORS);

      unredacted.log({ message: "request", customerEmail: "ada@example.com" });

      expect(probe.logRecords()[0]?.attributes["customerEmail"]).toBe("ada@example.com");
    });

    it("emits a substitute record and writes nothing of the original when a processor throws", () => {
      const broken = new TelemetryLogger("Spec", [
        () => {
          throw new TypeError("broken processor");
        },
      ]);

      broken.log({ message: "request", customerEmail: "ada@example.com" });

      const [record] = probe.logRecords();
      expect(record?.body).toContain("log redaction failed");
      expect(record?.severityText).toBe("ERROR");
      expect(JSON.stringify(record?.attributes)).not.toContain("ada@example.com");
      // And a second copy on stderr, for the case where the logging pipeline is
      // itself what is broken.
      expect(writtenToStderr.mock.calls.map((call) => String(call[0])).join("")).toContain(
        "a log processor threw",
      );
    });

    it("writes nothing at all when a processor drops the record", () => {
      const silent = new TelemetryLogger("Spec", [() => null]);

      silent.log({ message: "request", path: "/v1/users" });

      expect(probe.logRecords()).toHaveLength(0);
      expect(written).not.toHaveBeenCalled();
    });
  });

  /**
   * The point of the whole exercise: a log line written inside a request can be
   * found from that request's trace, and vice versa. The ids are stamped by the
   * SDK from the active context rather than by this class — see the note in
   * `telemetry-logger.ts` about why writing them by hand would produce fields
   * no backend joins on.
   */
  it("carries the active span's ids on the record", () => {
    trace.getTracer("spec").startActiveSpan("handler", (active) => {
      logger.log("inside the request", "Spec");
      active.end();
    });

    const [record] = probe.logRecords();
    expect(record?.spanContext?.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(record?.spanContext?.spanId).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe("TelemetryLogger with no SDK", () => {
  it("is the stock console logger, and emits nothing anywhere else", () => {
    const written = jest.spyOn(process.stdout, "write").mockReturnValue(true);
    try {
      const logger = new TelemetryLogger("Spec");

      expect(() => logger.log("no provider installed", "Spec")).not.toThrow();
      expect(written).toHaveBeenCalled();
    } finally {
      written.mockRestore();
    }
  });
});
