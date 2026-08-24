import { Injectable } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { EventsModule, OnDomainEvent } from "@/events";
import type { DomainEvent } from "@/events";
import { DomainEventBusPublisher } from "./domain-event-bus.publisher";
import { SubscriberFailedError } from "./outbox.errors";
import type { OutboxRecord } from "./outbox-record";

const record = (overrides: Partial<OutboxRecord> = {}): OutboxRecord =>
  ({
    id: "row-1",
    eventId: "evt-1",
    correlationId: "corr-1",
    occurredAt: new Date("2026-08-24T09:00:00.000Z"),
    attempts: 0,
    name: "user.registered",
    payload: {
      userId: "user-1",
      email: "relayed@example.test",
      name: "Ada",
      provider: null,
    },
    ...overrides,
  }) as OutboxRecord;

/** A subscriber that does not finish on the publisher's stack. */
@Injectable()
class SlowListener {
  finished = false;

  @OnDomainEvent("user.registered")
  async onRegistered(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 5));
    this.finished = true;
  }
}

@Injectable()
class RecordingListener {
  readonly seen: DomainEvent<"user.registered">[] = [];
  failWith: Error | null = null;

  @OnDomainEvent("user.registered")
  onRegistered(event: DomainEvent<"user.registered">): void {
    this.seen.push(event);
    if (this.failWith) throw this.failWith;
  }
}

describe("DomainEventBusPublisher", () => {
  let publisher: DomainEventBusPublisher;
  let listener: RecordingListener;
  let slow: SlowListener;

  beforeEach(async () => {
    const module = await Test.createTestingModule({
      imports: [EventsModule],
      providers: [DomainEventBusPublisher, RecordingListener, SlowListener],
    }).compile();

    // `EventSubscribersLoader` registers `@OnDomainEvent` methods in
    // `onApplicationBootstrap`, so a module that is only compiled has no
    // subscribers at all — see docs/events.md.
    await module.init();

    publisher = module.get(DomainEventBusPublisher);
    listener = module.get(RecordingListener);
    slow = module.get(SlowListener);
  });

  it("delivers the record to the bus", async () => {
    await publisher.publish(record());

    expect(listener.seen).toHaveLength(1);
    expect(listener.seen[0]?.payload).toMatchObject({ email: "relayed@example.test" });
  });

  /**
   * The property that makes redelivery safe to reason about.
   *
   * Outbox delivery is at-least-once, so a subscriber has to be able to tell a
   * redelivery from a second event — and the only thing distinguishing them is
   * the id. A relay that let the bus mint a fresh `randomUUID()` per attempt
   * would make every retry look like new work.
   */
  it("publishes under the row's own id and time, not fresh ones", async () => {
    await publisher.publish(record());
    await publisher.publish(record());

    expect(listener.seen.map((event) => event.id)).toEqual(["evt-1", "evt-1"]);
    expect(listener.seen[0]?.occurredAt).toBe("2026-08-24T09:00:00.000Z");
    expect(listener.seen[0]?.correlationId).toBe("corr-1");
  });

  /**
   * `publishAndSettle`, not `publish`.
   *
   * `publish` returns once every handler has *started*, which is right for
   * production code and wrong here: the relay is about to write `PUBLISHED`
   * against a row, and it may only do that once the reactions have actually
   * happened.
   */
  it("waits for subscribers rather than returning once they have started", async () => {
    await publisher.publish(record());

    expect(slow.finished).toBe(true);
  });

  /**
   * With an in-process bus there is no broker in between to hold the message on
   * a subscriber's behalf, so "delivered" can only mean "every subscriber
   * handled it". Resolving anyway would mark the row `PUBLISHED` and lose the
   * reaction — the exact failure the outbox was added to remove.
   */
  it("refuses to report delivery when a subscriber failed", async () => {
    listener.failWith = new Error("redis down");

    await expect(publisher.publish(record())).rejects.toThrow(SubscriberFailedError);
  });

  it("names the handler that failed, so a dead letter says who refused", async () => {
    listener.failWith = new Error("redis down");

    await expect(publisher.publish(record())).rejects.toThrow(
      /RecordingListener\.onRegistered: redis down/,
    );
  });

  it("identifies itself for the logs", () => {
    expect(publisher.name).toBe("domain-event-bus");
  });
});
