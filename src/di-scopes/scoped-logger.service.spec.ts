import { Logger } from "@nestjs/common";
import { InstantiationLedger } from "./instantiation-ledger.service";
import { ScopedLogger } from "./scoped-logger.service";

describe("ScopedLogger", () => {
  let ledger: InstantiationLedger;

  beforeEach(() => {
    ledger = new InstantiationLedger();
  });

  describe("naming its host", () => {
    it("uses the class name when the inquirer is a class instance", () => {
      class UsersService {}

      expect(new ScopedLogger(ledger, new UsersService()).host).toBe("UsersService");
    });

    it("uses the token itself when the host was bound by a string token", () => {
      // `INQUIRER` is the consuming instance for a class provider and the
      // host's token for a `useFactory` one. Both are named, because
      // "[object Object]" in a log line is a defect that survives for years.
      expect(new ScopedLogger(ledger, "PAYMENT_GATEWAY").host).toBe("PAYMENT_GATEWAY");
    });

    it("falls back to unknown when there is no inquirer at all", () => {
      expect(new ScopedLogger(ledger).host).toBe("unknown");
      expect(new ScopedLogger(ledger, Object.create(null) as object).host).toBe("unknown");
    });
  });

  it("records one construction per instance", () => {
    new ScopedLogger(ledger);
    new ScopedLogger(ledger);

    expect(ledger.countFor(ScopedLogger.name)).toBe(2);
  });

  it("logs through a logger contexted to its host, at each level", () => {
    class ReportBuilder {}
    const log = jest.spyOn(Logger.prototype, "log").mockImplementation(() => undefined);
    const warn = jest.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    const debug = jest.spyOn(Logger.prototype, "debug").mockImplementation(() => undefined);

    const logger = new ScopedLogger(ledger, new ReportBuilder());
    logger.log("built");
    logger.warn("slow");
    logger.debug("details");

    expect(log).toHaveBeenCalledWith("built");
    expect(warn).toHaveBeenCalledWith("slow");
    expect(debug).toHaveBeenCalledWith("details");
    // The context is the host's name, which is the whole reason each consumer
    // gets its own instance rather than sharing one.
    expect(log.mock.instances[0]).toMatchObject({ context: "ReportBuilder" });

    log.mockRestore();
    warn.mockRestore();
    debug.mockRestore();
  });
});
