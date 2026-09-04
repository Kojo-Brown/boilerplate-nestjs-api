import { Injectable, Logger } from "@nestjs/common";
import { EventEmitterModule } from "@nestjs/event-emitter";
import { CqrsModule, EventsHandler } from "@nestjs/cqrs";
import type { IEventHandler } from "@nestjs/cqrs";
import { Test } from "@nestjs/testing";
import type { TestingModule } from "@nestjs/testing";
import { DomainEventBus } from "@/events";
import { DomainEventCqrsBridge } from "./domain-event-cqrs.bridge";
import {
  DOMAIN_EVENT_NOTIFICATIONS,
  DomainEventNotification,
  UserDeletedEvent,
  UserRegisteredEvent,
  toNotification,
} from "./domain-event-notifications";
import type { DomainEventName } from "@/events";

const REGISTERED = {
  userId: "user-1",
  email: "erin@example.com",
  name: "Erin",
  provider: null,
} as const;

const DELETED = { userId: "user-1", email: "erin@example.com" } as const;

/** Records what reached the CQRS side, so assertions are about the object handlers see. */
@Injectable()
@EventsHandler(UserRegisteredEvent, UserDeletedEvent)
class RecordingProjection implements IEventHandler<UserRegisteredEvent | UserDeletedEvent> {
  readonly received: DomainEventNotification[] = [];

  handle(event: UserRegisteredEvent | UserDeletedEvent): void {
    this.received.push(event);
  }
}

/**
 * Throws where nothing awaits it, which is the case worth pinning: the CQRS bus
 * catches it, and without a subscriber on `UnhandledExceptionBus` the failure
 * would be invisible rather than merely contained.
 */
@Injectable()
@EventsHandler(UserRegisteredEvent)
class FailingProjection implements IEventHandler<UserRegisteredEvent> {
  handle(): void {
    throw new Error("projection is broken");
  }
}

async function moduleWith(...handlers: unknown[]): Promise<TestingModule> {
  const module = await Test.createTestingModule({
    imports: [EventEmitterModule.forRoot({ wildcard: false, delimiter: "." }), CqrsModule],
    providers: [DomainEventBus, DomainEventCqrsBridge, ...(handlers as never[])],
  }).compile();
  // Two loaders run on `onApplicationBootstrap`: the one that subscribes
  // `@OnDomainEvent` methods to the emitter, and `CqrsModule`'s explorer, which
  // binds `@EventsHandler` classes to the event bus. Without `init()` neither
  // half of the bridge would be connected and every test here would pass
  // against nothing.
  await module.init();
  return module;
}

describe("DomainEventCqrsBridge", () => {
  let module: TestingModule;

  afterEach(async () => {
    await module?.close();
    jest.restoreAllMocks();
  });

  it("delivers a published domain event to an @EventsHandler as its notification class", async () => {
    module = await moduleWith(RecordingProjection);

    await module.get(DomainEventBus).publishAndSettle("user.registered", REGISTERED);

    const [received] = module.get(RecordingProjection).received;
    expect(received).toBeInstanceOf(UserRegisteredEvent);
    expect(received?.payload).toEqual(REGISTERED);
  });

  it("carries the envelope, so a handler sees the same id the publisher minted", async () => {
    module = await moduleWith(RecordingProjection);
    const bus = module.get(DomainEventBus);

    const { event } = await bus.publishAndSettle("user.registered", REGISTERED, {
      correlationId: "req-42",
    });

    const [received] = module.get(RecordingProjection).received;
    expect(received?.id).toBe(event.id);
    expect(received?.envelope).toEqual(event);
    expect(received?.envelope.correlationId).toBe("req-42");
  });

  it("routes each event to its own notification class", async () => {
    module = await moduleWith(RecordingProjection);
    const bus = module.get(DomainEventBus);

    await bus.publishAndSettle("user.registered", REGISTERED);
    await bus.publishAndSettle("user.deleted", DELETED);

    expect(module.get(RecordingProjection).received.map((event) => event.constructor)).toEqual([
      UserRegisteredEvent,
      UserDeletedEvent,
    ]);
  });

  /**
   * The property that makes the bridge safe to put in front of the outbox
   * relay. The relay reads `publishAndSettle`'s report to decide whether a row
   * is delivered; a projection that threw must not be able to make it hold the
   * row back, because the CQRS bus offers no retry that could ever clear it.
   */
  it("reports ok even when a projection throws, so a broken read model cannot stall the relay", async () => {
    // The bus logs the caught error itself; silenced so the suite's output is
    // not a stack trace for the one failure it is deliberately provoking.
    jest.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
    module = await moduleWith(RecordingProjection, FailingProjection);

    const report = await module.get(DomainEventBus).publishAndSettle("user.registered", REGISTERED);

    expect(report.failed).toEqual([]);
    // And the working projection still ran.
    expect(module.get(RecordingProjection).received).toHaveLength(1);
  });

  it("publishes nothing of its own: every notification comes from a domain event", async () => {
    module = await moduleWith(RecordingProjection);

    await module.get(DomainEventBus).publishAndSettle("user.deleted", DELETED);

    expect(module.get(RecordingProjection).received).toHaveLength(1);
  });
});

describe("domain event notifications", () => {
  it("has a notification class for every event in the catalogue", () => {
    // The mapped type makes a missing entry a compile error; this asserts the
    // runtime side of the same claim, which is what `toNotification` indexes.
    const names: DomainEventName[] = ["user.registered", "user.deleted"];
    for (const name of names) {
      expect(DOMAIN_EVENT_NOTIFICATIONS[name]).toBeDefined();
    }
  });

  it("wraps an envelope in the class registered for its name", () => {
    const notification = toNotification({
      id: "event-1",
      name: "user.deleted",
      occurredAt: "2026-01-01T00:00:00.000Z",
      correlationId: null,
      payload: DELETED,
    });

    expect(notification).toBeInstanceOf(UserDeletedEvent);
    expect(notification.name).toBe("user.deleted");
    expect(notification.payload).toEqual(DELETED);
  });
});
