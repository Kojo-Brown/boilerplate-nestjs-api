import { Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { Env } from "@/config/env.schema";
import type { DomainEventBus, PublishReport } from "@/events";
import { InMemoryBroker } from "./in-memory-broker";
import { DomainEventConsumer } from "./domain-event-consumer.service";
import { encodeDomainEvent, type EncodedDomainEvent } from "./domain-event-codec";
import { EVENT_HEADERS } from "./domain-event-codec";

const TOPIC = "domain-events";

const event: EncodedDomainEvent = {
  name: "user.registered",
  payload: { userId: "user-1", email: "ada@example.test", name: "Ada", provider: null },
  eventId: "44444444-4444-4444-8444-444444444444",
  occurredAt: new Date("2026-08-27T10:00:00.000Z"),
  correlationId: "req-3",
};

interface Settled {
  name: string;
  payload: unknown;
  context: { eventId?: string; occurredAt?: Date; correlationId?: string | null };
}

/** A bus that records what it was asked to publish and reports what it is told to. */
function busThat(failures: () => readonly string[]): {
  bus: DomainEventBus;
  settled: Settled[];
} {
  const settled: Settled[] = [];
  const bus = {
    publishAndSettle: async (name: string, payload: unknown, context: Settled["context"] = {}) => {
      settled.push({ name, payload, context });
      const failed = failures().map((handler) => ({
        handler,
        status: "failed" as const,
        error: "boom",
      }));
      return { event: {}, outcomes: failed, failed } as unknown as PublishReport;
    },
  } as unknown as DomainEventBus;
  return { bus, settled };
}

function configWith(overrides: Partial<Env> = {}): ConfigService<Env, true> {
  const values: Record<string, unknown> = {
    KAFKA_CONSUMER_ENABLED: true,
    KAFKA_CONSUMER_GROUP_ID: "spec-group",
    ...overrides,
  };
  return { get: (key: string) => values[key] } as unknown as ConfigService<Env, true>;
}

describe("DomainEventConsumer", () => {
  let broker: InMemoryBroker;

  beforeEach(async () => {
    broker = new InMemoryBroker({ defaultPartitions: 1, redeliveryDelayMs: 5 });
    await broker.connect();
  });

  afterEach(async () => {
    await broker.disconnect();
    jest.restoreAllMocks();
  });

  async function start(bus: DomainEventBus, config = configWith()): Promise<DomainEventConsumer> {
    const consumer = new DomainEventConsumer(broker, TOPIC, bus, config);
    await consumer.start();
    return consumer;
  }

  it("puts a consumed message on the bus under the producer's identity", async () => {
    const { bus, settled } = busThat(() => []);
    const consumer = await start(bus);

    await broker.produce([encodeDomainEvent(TOPIC, event)]);
    await waitFor(() => settled.length === 1);

    expect(settled[0]!.name).toBe("user.registered");
    expect(settled[0]!.payload).toEqual(event.payload);
    // Not a fresh id and not the time the consumer got round to it: a
    // redelivery has to look like the same event to a subscriber
    // deduplicating on the id.
    expect(settled[0]!.context.eventId).toBe(event.eventId);
    expect(settled[0]!.context.occurredAt).toEqual(event.occurredAt);
    expect(settled[0]!.context.correlationId).toBe("req-3");

    await consumer.stop();
  });

  it("does not commit when a subscriber failed, so the event is redelivered", async () => {
    let failing = true;
    const { bus, settled } = busThat(() =>
      failing ? ["WelcomeEmailListener.onUserRegistered"] : [],
    );
    const consumer = await start(bus);

    await broker.produce([encodeDomainEvent(TOPIC, event)]);
    await waitFor(() => settled.length >= 1);
    failing = false;

    // The same event, again — which is also why handlers have to be
    // idempotent: the subscribers that succeeded the first time run again.
    await waitFor(() => settled.length >= 2);
    expect(settled[1]!.context.eventId).toBe(event.eventId);

    await consumer.stop();
  });

  it("commits past an undecodable message instead of blocking the partition", async () => {
    const errors = jest.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
    const { bus, settled } = busThat(() => []);
    const consumer = await start(bus);

    const undecodable = encodeDomainEvent(TOPIC, event);
    const headers = { ...undecodable.headers, [EVENT_HEADERS.name]: "user.renamed" };
    await broker.produce([
      { ...undecodable, headers },
      // Behind it on the same partition, since both carry the same key. If the
      // undecodable message were retried rather than skipped, this one would
      // never be handled — and no version of this build could ever make the
      // first one decodable, so the partition would stop for good.
      encodeDomainEvent(TOPIC, { ...event, eventId: "55555555-5555-4555-8555-555555555555" }),
    ]);

    await waitFor(() => settled.length === 1);
    expect(settled[0]!.context.eventId).toBe("55555555-5555-4555-8555-555555555555");
    // Dropping a message is a real loss, so it has to be loud.
    expect(errors).toHaveBeenCalledWith(expect.stringContaining("undecodable"));

    await consumer.stop();
  });

  it("reads nothing when disabled", async () => {
    const { bus, settled } = busThat(() => []);
    const consumer = await start(bus, configWith({ KAFKA_CONSUMER_ENABLED: false }));

    await broker.produce([encodeDomainEvent(TOPIC, event)]);
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(settled).toHaveLength(0);
    // Destroying a consumer that never subscribed must not throw — a producer-
    // only replica shuts down through this path on every deploy.
    await expect(consumer.stop()).resolves.toBeUndefined();
  });
});

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("timed out");
}
