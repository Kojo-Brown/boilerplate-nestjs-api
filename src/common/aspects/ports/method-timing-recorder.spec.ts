import { Logger } from "@nestjs/common";
import { LoggingMethodTimingRecorder } from "./method-timing-recorder.port";
import type { MethodTiming } from "./method-timing-recorder.port";

const sample = (overrides: Partial<MethodTiming> = {}): MethodTiming => ({
  name: "UsersService.list",
  target: "UsersService",
  method: "list",
  durationMs: 12,
  outcome: "success",
  slow: false,
  ...overrides,
});

describe("LoggingMethodTimingRecorder", () => {
  let recorder: LoggingMethodTimingRecorder;
  let debug: jest.SpyInstance;
  let warn: jest.SpyInstance;

  beforeEach(() => {
    recorder = new LoggingMethodTimingRecorder();
    debug = jest.spyOn(Logger.prototype, "debug").mockImplementation();
    warn = jest.spyOn(Logger.prototype, "warn").mockImplementation();
  });

  afterEach(() => jest.restoreAllMocks());

  it("logs a healthy sample at debug, as one structured line", () => {
    recorder.record(sample());

    expect(warn).not.toHaveBeenCalled();
    expect(JSON.parse(String(debug.mock.calls[0]?.[0]))).toEqual({
      metric: "UsersService.list",
      target: "UsersService",
      method: "list",
      durationMs: 12,
      outcome: "success",
      slow: false,
      error: null,
    });
  });

  it("raises a slow sample to warn", () => {
    recorder.record(sample({ slow: true }));

    expect(warn).toHaveBeenCalledTimes(1);
    expect(debug).not.toHaveBeenCalled();
  });

  it("raises a failure to warn and carries the error through", () => {
    recorder.record(
      sample({ outcome: "failure", error: { name: "Error", message: "upstream 503" } }),
    );

    expect(JSON.parse(String(warn.mock.calls[0]?.[0])).error).toEqual({
      name: "Error",
      message: "upstream 503",
    });
  });
});
