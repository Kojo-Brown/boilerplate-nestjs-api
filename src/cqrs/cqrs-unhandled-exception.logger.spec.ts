import { Logger } from "@nestjs/common";
import { UnhandledExceptionBus } from "@nestjs/cqrs";
import { CqrsUnhandledExceptionLogger } from "./cqrs-unhandled-exception.logger";
import { UserRegisteredEvent } from "./domain-event-notifications";

const ENVELOPE = {
  id: "event-1",
  name: "user.registered",
  occurredAt: "2026-01-01T00:00:00.000Z",
  correlationId: null,
  payload: { userId: "user-1", email: "erin@example.com", name: "Erin", provider: null },
} as const;

describe("CqrsUnhandledExceptionLogger", () => {
  let unhandled: UnhandledExceptionBus;
  let subscriber: CqrsUnhandledExceptionLogger;
  let error: jest.SpyInstance;

  beforeEach(() => {
    unhandled = new UnhandledExceptionBus();
    subscriber = new CqrsUnhandledExceptionLogger(unhandled);
    error = jest.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
    subscriber.onModuleInit();
  });

  afterEach(() => {
    subscriber.onModuleDestroy();
    jest.restoreAllMocks();
  });

  it("logs the failure, naming the event that caused it", () => {
    unhandled.publish({
      cause: new UserRegisteredEvent(ENVELOPE),
      exception: new Error("projection is broken"),
    });

    expect(error).toHaveBeenCalledWith(
      expect.stringContaining("UserRegisteredEvent"),
      expect.any(String),
    );
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining("projection is broken"),
      expect.any(String),
    );
  });

  it("handles a thrown non-Error, which is what a rejected string arrives as", () => {
    unhandled.publish({ cause: new UserRegisteredEvent(ENVELOPE), exception: "boom" });

    expect(error).toHaveBeenCalledWith(expect.stringContaining("boom"), expect.any(String));
  });

  it("says something useful when the cause is not an object at all", () => {
    unhandled.publish({ cause: undefined as never, exception: new Error("boom") });

    expect(error).toHaveBeenCalledWith(
      expect.stringContaining("an unknown source"),
      expect.any(String),
    );
  });

  it("stops logging once the module is destroyed", () => {
    subscriber.onModuleDestroy();

    unhandled.publish({
      cause: new UserRegisteredEvent(ENVELOPE),
      exception: new Error("too late"),
    });

    expect(error).not.toHaveBeenCalled();
  });
});
