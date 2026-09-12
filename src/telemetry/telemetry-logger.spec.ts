import { trace } from "@opentelemetry/api";
import { SeverityNumber } from "@opentelemetry/api-logs";
import { installInMemoryTelemetry, type TelemetryProbe } from "@/test-utils/in-memory-telemetry";
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

  it("keeps an error's stack rather than dropping it", () => {
    const failure = new Error("broker unreachable");

    logger.error("publish failed", failure.stack, "BrokerOutboxPublisher");

    const [record] = probe.logRecords();
    expect(record?.attributes["log.context"]).toBe("BrokerOutboxPublisher");
    expect(String(record?.attributes["log.extra"])).toContain("broker unreachable");
  });

  it("serialises a non-string message rather than logging [object Object]", () => {
    logger.log({ event: "user.registered", userId: "user-1" });

    expect(probe.logRecords()[0]?.body).toBe('{"event":"user.registered","userId":"user-1"}');
  });

  it("survives a message that cannot be serialised", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic["self"] = cyclic;

    expect(() => logger.log(cyclic)).not.toThrow();
    expect(probe.logRecords()).toHaveLength(1);
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
