import { Logger } from "@nestjs/common";
import { OnDomainEvent, isHandlerOutcome } from "./on-domain-event";
import type { DomainEvent, HandlerOutcome } from "./domain-event";

const EVENT: DomainEvent<"user.registered"> = {
  id: "event-1",
  name: "user.registered",
  occurredAt: "2026-01-01T00:00:00.000Z",
  correlationId: null,
  payload: { userId: "user-1", email: "erin@example.com", name: "Erin", provider: null },
};

/**
 * The decorator rewrites the method, so these tests call the rewritten method
 * directly rather than through the emitter. `domain-event-bus.service.spec.ts`
 * covers the other half — that the loader still finds and subscribes it.
 */
class Subject {
  calls: DomainEvent<"user.registered">[] = [];
  boom: unknown = null;

  @OnDomainEvent("user.registered")
  async onUserRegistered(event: DomainEvent<"user.registered">): Promise<void> {
    this.calls.push(event);
    if (this.boom) throw this.boom;
  }

  @OnDomainEvent("user.registered")
  syncHandler(event: DomainEvent<"user.registered">): void {
    this.calls.push(event);
    if (this.boom) throw this.boom;
  }
}

/** The wrapper's return type is not the method's, so call it through this. */
const invoke = (subject: Subject, method: "onUserRegistered" | "syncHandler") =>
  subject[method](EVENT) as unknown as Promise<HandlerOutcome>;

describe("OnDomainEvent", () => {
  let error: jest.SpyInstance;

  beforeEach(() => {
    error = jest.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("passes the event through to the decorated method", async () => {
    const subject = new Subject();

    await invoke(subject, "onUserRegistered");

    expect(subject.calls).toEqual([EVENT]);
  });

  it("reports success as an outcome naming the class and method", async () => {
    const outcome = await invoke(new Subject(), "onUserRegistered");

    expect(outcome).toEqual({ handler: "Subject.onUserRegistered", status: "ok" });
  });

  it("turns a rejection into a failed outcome instead of propagating it", async () => {
    const subject = new Subject();
    subject.boom = new Error("queue unreachable");

    const outcome = await invoke(subject, "onUserRegistered");

    expect(outcome).toEqual({
      handler: "Subject.onUserRegistered",
      status: "failed",
      error: "queue unreachable",
    });
  });

  it("contains a synchronous throw the same way", async () => {
    const subject = new Subject();
    subject.boom = new Error("bad payload");

    await expect(invoke(subject, "syncHandler")).resolves.toEqual({
      handler: "Subject.syncHandler",
      status: "failed",
      error: "bad payload",
    });
  });

  it("describes a thrown non-Error rather than logging [object Object]", async () => {
    const subject = new Subject();
    subject.boom = "connection reset";

    const outcome = await invoke(subject, "onUserRegistered");

    expect(outcome.error).toBe("connection reset");
  });

  it("logs the failure with the event name and id, since the caller will not see it", async () => {
    const subject = new Subject();
    subject.boom = new Error("queue unreachable");

    await invoke(subject, "onUserRegistered");

    expect(error).toHaveBeenCalledWith(
      "Handling user.registered (event-1) failed: queue unreachable",
      expect.stringContaining("Error: queue unreachable"),
    );
  });

  it("refuses to decorate anything that is not a method", () => {
    expect(() => {
      class Bad {
        // A property holding a function is not on the prototype, so the loader
        // would never find it and the handler would silently never run.
        onUserRegistered = (): void => undefined;
      }
      const descriptor = Object.getOwnPropertyDescriptor(Bad.prototype, "onUserRegistered") ?? {};
      OnDomainEvent("user.registered")(Bad.prototype, "onUserRegistered", descriptor);
    }).toThrow(/must decorate a method/);
  });
});

describe("isHandlerOutcome", () => {
  it.each([
    [{ handler: "A.b", status: "ok" }, true],
    [{ handler: "A.b", status: "failed", error: "x" }, true],
    [{ handler: "A.b", status: "unknown" }, false],
    [{ status: "ok" }, false],
    [undefined, false],
    [null, false],
    ["ok", false],
  ])("classifies %p as %p", (value, expected) => {
    expect(isHandlerOutcome(value)).toBe(expected);
  });
});
