import { Injectable, Logger } from "@nestjs/common";
import type { Type } from "@nestjs/common";
import { EventEmitter2, EventEmitterModule, OnEvent } from "@nestjs/event-emitter";
import { Test } from "@nestjs/testing";
import type { TestingModule } from "@nestjs/testing";
import { DomainEventBus } from "./domain-event-bus.service";
import { OnDomainEvent } from "./on-domain-event";
import type { DomainEvent } from "./domain-event";

const REGISTERED = {
  userId: "user-1",
  email: "erin@example.com",
  name: "Erin",
  provider: null,
} as const;

/** Records what it received so a test can assert on the envelope, not a spy call. */
@Injectable()
class RecordingListener {
  readonly received: DomainEvent<"user.registered">[] = [];

  @OnDomainEvent("user.registered")
  onUserRegistered(event: DomainEvent<"user.registered">): void {
    this.received.push(event);
  }
}

/** A second subscriber on the same event: the fan-out the pattern exists for. */
@Injectable()
class CountingListener {
  calls = 0;

  @OnDomainEvent("user.registered")
  async onUserRegistered(): Promise<void> {
    await Promise.resolve();
    this.calls += 1;
  }
}

@Injectable()
class FailingListener {
  @OnDomainEvent("user.registered")
  async onUserRegistered(): Promise<void> {
    await Promise.resolve();
    throw new Error("queue unreachable");
  }
}

/** Subscribed the framework's way rather than ours, to pin what that costs. */
@Injectable()
class PlainOnEventListener {
  calls = 0;

  @OnEvent("user.registered")
  onUserRegistered(): void {
    this.calls += 1;
  }
}

/** Blocks until released, so a `publish` that awaited its subscribers would show. */
@Injectable()
class SlowListener {
  finished = false;
  private openGate: () => void = () => undefined;
  private readonly gate = new Promise<void>((resolve) => {
    this.openGate = resolve;
  });

  release(): void {
    this.openGate();
  }

  @OnDomainEvent("user.registered")
  async onUserRegistered(): Promise<void> {
    await this.gate;
    this.finished = true;
  }
}

async function moduleWith(...listeners: Type<unknown>[]): Promise<TestingModule> {
  const module = await Test.createTestingModule({
    imports: [EventEmitterModule.forRoot({ wildcard: false, delimiter: "." })],
    providers: [DomainEventBus, ...listeners],
  }).compile();
  // `EventSubscribersLoader` registers listeners on `onApplicationBootstrap`,
  // which `compile()` does not run. Without this every test below would pass
  // against an emitter that has no subscribers at all.
  await module.init();
  return module;
}

describe("DomainEventBus", () => {
  let module: TestingModule;

  afterEach(async () => {
    await module?.close();
    jest.restoreAllMocks();
  });

  describe("envelope", () => {
    it("stamps an id, a timestamp and the payload, and returns what it sent", async () => {
      module = await moduleWith(RecordingListener);
      const bus = module.get(DomainEventBus);

      const published = bus.publish("user.registered", REGISTERED);
      await module.get(DomainEventBus).publishAndSettle("user.registered", REGISTERED);

      expect(published.name).toBe("user.registered");
      expect(published.payload).toEqual(REGISTERED);
      expect(published.correlationId).toBeNull();
      expect(published.id).toMatch(/^[0-9a-f-]{36}$/);
      expect(Date.parse(published.occurredAt)).not.toBeNaN();

      const [delivered] = module.get(RecordingListener).received;
      expect(delivered).toEqual(published);
    });

    it("gives every emission its own id", async () => {
      module = await moduleWith(RecordingListener);
      const bus = module.get(DomainEventBus);

      const first = bus.publish("user.registered", REGISTERED);
      const second = bus.publish("user.registered", REGISTERED);

      expect(first.id).not.toEqual(second.id);
    });

    it("carries a correlation id when the publisher has one", async () => {
      module = await moduleWith(RecordingListener);

      const event = module
        .get(DomainEventBus)
        .publish("user.registered", REGISTERED, { correlationId: "req-42" });

      expect(event.correlationId).toBe("req-42");
    });
  });

  describe("publish", () => {
    it("reaches every subscriber of the event", async () => {
      module = await moduleWith(RecordingListener, CountingListener);

      const report = await module
        .get(DomainEventBus)
        .publishAndSettle("user.registered", REGISTERED);

      expect(report.outcomes).toHaveLength(2);
      expect(module.get(RecordingListener).received).toHaveLength(1);
      expect(module.get(CountingListener).calls).toBe(1);
    });

    it("delivers nothing to subscribers of a different event", async () => {
      module = await moduleWith(RecordingListener);

      await module
        .get(DomainEventBus)
        .publishAndSettle("user.deleted", { userId: "user-1", email: "erin@example.com" });

      expect(module.get(RecordingListener).received).toHaveLength(0);
    });

    it("returns before a slow subscriber has finished", async () => {
      module = await moduleWith(SlowListener);
      const listener = module.get(SlowListener);

      module.get(DomainEventBus).publish("user.registered", REGISTERED);

      expect(listener.finished).toBe(false);
      listener.release();
      await new Promise((resolve) => setImmediate(resolve));
      expect(listener.finished).toBe(true);
    });

    it("does not throw when a subscriber does, and lets the others run", async () => {
      module = await moduleWith(FailingListener, CountingListener);
      jest.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);

      expect(() => module.get(DomainEventBus).publish("user.registered", REGISTERED)).not.toThrow();

      // Let the failing handler reject and the sibling resolve.
      await new Promise((resolve) => setImmediate(resolve));
      expect(module.get(CountingListener).calls).toBe(1);
    });

    it("survives an event nobody subscribes to", async () => {
      module = await moduleWith();

      const report = await module
        .get(DomainEventBus)
        .publishAndSettle("user.deleted", { userId: "user-1", email: "erin@example.com" });

      expect(report.outcomes).toEqual([]);
      expect(report.failed).toEqual([]);
    });
  });

  describe("publishAndSettle", () => {
    it("waits for the subscribers and names the one that failed", async () => {
      module = await moduleWith(FailingListener, CountingListener);
      jest.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);

      const report = await module
        .get(DomainEventBus)
        .publishAndSettle("user.registered", REGISTERED);

      expect(module.get(CountingListener).calls).toBe(1);
      expect(report.failed).toEqual([
        {
          handler: "FailingListener.onUserRegistered",
          status: "failed",
          error: "queue unreachable",
        },
      ]);
      expect(report.outcomes).toHaveLength(2);
      expect(report.outcomes).toContainEqual({
        handler: "CountingListener.onUserRegistered",
        status: "ok",
      });
    });

    it("reports no failures when every subscriber succeeds", async () => {
      module = await moduleWith(RecordingListener, CountingListener);

      const report = await module
        .get(DomainEventBus)
        .publishAndSettle("user.registered", REGISTERED);

      expect(report.failed).toEqual([]);
      expect(report.event.payload).toEqual(REGISTERED);
    });

    it("counts a plain @OnEvent subscriber but cannot report on it", async () => {
      module = await moduleWith(PlainOnEventListener);

      const report = await module
        .get(DomainEventBus)
        .publishAndSettle("user.registered", REGISTERED);

      expect(module.get(PlainOnEventListener).calls).toBe(1);
      // No handler name and no way to see a failure: the framework catches it
      // first. This is the gap `@OnDomainEvent` closes, pinned so that a change
      // in `@nestjs/event-emitter` shows up here.
      expect(report.outcomes).toEqual([{ handler: "listener#0", status: "ok" }]);
    });
  });

  describe("dispatch failures outside a handler", () => {
    it("treats a non-promise return from emitAsync as no subscribers", async () => {
      module = await moduleWith();
      // `emitAsync` is typed `Promise<unknown[]>` but can return `false`.
      // Awaiting that blindly is a `TypeError`; the bus reports nothing handled.
      jest
        .spyOn(module.get(EventEmitter2), "emitAsync")
        .mockReturnValue(false as unknown as Promise<unknown[]>);

      const report = await module
        .get(DomainEventBus)
        .publishAndSettle("user.registered", REGISTERED);

      expect(report.outcomes).toEqual([]);
    });

    it("logs rather than rejecting when the emitter itself throws", async () => {
      module = await moduleWith();
      const bus = module.get(DomainEventBus);
      const error = jest.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
      jest.spyOn(module.get(EventEmitter2), "emitAsync").mockRejectedValue(new Error("boom"));

      const event = bus.publish("user.registered", REGISTERED);
      await new Promise((resolve) => setImmediate(resolve));

      expect(error).toHaveBeenCalledWith(expect.stringContaining(`(${event.id}) rejected: boom`));
    });
  });
});
