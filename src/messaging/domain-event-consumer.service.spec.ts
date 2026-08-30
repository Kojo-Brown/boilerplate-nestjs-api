import { Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { Env } from "@/config/env.schema";
import type { DomainEventBus, PublishReport } from "@/events";
import { InMemoryBroker } from "./in-memory-broker";
import { DeadLetterQueue } from "./dead-letter-queue.service";
import { DomainEventConsumer } from "./domain-event-consumer.service";
import { DEAD_LETTER_HEADERS } from "./dead-letter";
import { encodeDomainEvent, type EncodedDomainEvent } from "./domain-event-codec";
import { EVENT_HEADERS } from "./domain-event-codec";
import { realEventContract } from "@/test-utils/event-contract";
import type { IncomingMessage, MessageBroker } from "./ports";

const TOPIC = "domain-events";
const DLT = "domain-events.dlt";
const contract = realEventContract();

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
    KAFKA_RETRY_MAX_ATTEMPTS: 3,
    KAFKA_RETRY_BASE_MS: 250,
    KAFKA_RETRY_MAX_DELAY_MS: 5_000,
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

  /**
   * The consumer under test, with the ladder's jitter pinned to zero.
   *
   * Every retry then sleeps for `floor(0 × ceiling)` — no wait at all — so these
   * specs assert the ladder's *shape* without spending its schedule. The one
   * spec that needs a real delay sets its own.
   */
  async function start(
    bus: DomainEventBus,
    options: {
      config?: ConfigService<Env, true>;
      deadLetters?: DeadLetterQueue;
      random?: () => number;
    } = {},
  ): Promise<DomainEventConsumer> {
    const consumer = new DomainEventConsumer(
      broker,
      TOPIC,
      bus,
      options.deadLetters ?? new DeadLetterQueue(broker, DLT),
      contract,
      options.config ?? configWith(),
      options.random ?? ((): number => 0),
    );
    await consumer.start();
    return consumer;
  }

  /** Reads everything that reaches the dead-letter topic. */
  async function readDeadLetters(): Promise<{
    received: IncomingMessage[];
    stop: () => Promise<void>;
  }> {
    const received: IncomingMessage[] = [];
    const subscription = await broker.subscribe({
      groupId: "dlt-reader",
      topics: [DLT],
      fromBeginning: true,
      handle: async (message) => {
        received.push(message);
      },
    });
    return { received, stop: () => subscription.stop() };
  }

  it("puts a consumed message on the bus under the producer's identity", async () => {
    const { bus, settled } = busThat(() => []);
    const consumer = await start(bus);

    await broker.produce([encodeDomainEvent(TOPIC, event, contract)]);
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

  it("retries a failing subscriber in place and commits once it succeeds", async () => {
    // Counted rather than flipped from the test body. A flag toggled while the
    // ladder is running settles a *different* attempt depending on where the
    // scheduler is, which makes both the retry count and the commit racy —
    // reproduced by running this spec in a loop before it was written this way.
    let attempts = 0;
    const { bus, settled } = busThat(() =>
      (attempts += 1) === 1 ? ["WelcomeEmailListener.onUserRegistered"] : [],
    );
    const consumer = await start(bus);

    await broker.produce([encodeDomainEvent(TOPIC, event, contract)]);
    await waitFor(() => settled.length >= 2);

    // The same event again, from the ladder rather than from a redelivery — and
    // which of the two it was does not change the obligation on a subscriber:
    // the ones that succeeded the first time run again, so handlers have to be
    // idempotent.
    expect(settled[1]!.context.eventId).toBe(event.eventId);

    // Two and only two: the second attempt succeeded, so the offset is
    // committed and the message does not come back.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(settled).toHaveLength(2);

    await consumer.stop();
  });

  it("dead-letters after the ladder is spent and lets the partition continue", async () => {
    jest.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    const poison = "44444444-4444-4444-8444-444444444444";
    const { bus, settled } = busThat(() =>
      // The first event fails forever; the one behind it on the same partition
      // is fine. Before there was anywhere to put the first, the second was
      // never handled at all.
      settled.at(-1)?.context.eventId === poison ? ["WelcomeEmailListener.onUserRegistered"] : [],
    );
    const dlt = await readDeadLetters();
    const consumer = await start(bus);

    await broker.produce([
      encodeDomainEvent(TOPIC, event, contract),
      encodeDomainEvent(
        TOPIC,
        { ...event, eventId: "55555555-5555-4555-8555-555555555555" },
        contract,
      ),
    ]);

    await waitFor(() => dlt.received.length === 1);
    const dead = dlt.received[0]!;
    expect(dead.headers[DEAD_LETTER_HEADERS.reason]).toBe("handler-failed");
    // Three attempts, which is `KAFKA_RETRY_MAX_ATTEMPTS` and not one more.
    expect(dead.headers[DEAD_LETTER_HEADERS.attempts]).toBe("3");
    expect(dead.headers[DEAD_LETTER_HEADERS.originTopic]).toBe(TOPIC);
    expect(dead.headers[DEAD_LETTER_HEADERS.group]).toBe("spec-group");
    expect(dead.headers[EVENT_HEADERS.id]).toBe(poison);

    // The whole point: the message behind the poison one is handled.
    await waitFor(() =>
      settled.some((entry) => entry.context.eventId === "55555555-5555-4555-8555-555555555555"),
    );
    // Exactly three attempts on the poison event, not a fourth from a
    // redelivery — which would mean the offset had not been committed.
    expect(settled.filter((entry) => entry.context.eventId === poison)).toHaveLength(3);

    await consumer.stop();
    await dlt.stop();
  });

  it("dead-letters an undecodable message without spending the ladder on it", async () => {
    const errors = jest.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
    const { bus, settled } = busThat(() => []);
    const dlt = await readDeadLetters();
    const consumer = await start(bus);

    const undecodable = encodeDomainEvent(TOPIC, event, contract);
    const headers = { ...undecodable.headers, [EVENT_HEADERS.name]: "user.renamed" };
    await broker.produce([
      { ...undecodable, headers },
      // Behind it on the same partition, since both carry the same key.
      encodeDomainEvent(
        TOPIC,
        { ...event, eventId: "55555555-5555-4555-8555-555555555555" },
        contract,
      ),
    ]);

    await waitFor(() => dlt.received.length === 1);
    const dead = dlt.received[0]!;
    expect(dead.headers[DEAD_LETTER_HEADERS.reason]).toBe("undecodable");
    // One, not three. Bytes this build cannot parse will not become parseable
    // by being read again, so spending the budget on them delays the inevitable
    // and holds the partition while it does.
    expect(dead.headers[DEAD_LETTER_HEADERS.attempts]).toBe("1");
    expect(dead.headers[DEAD_LETTER_HEADERS.errorType]).toBe("UndecodableMessageError");
    // The bytes are preserved exactly, because they are the evidence.
    expect(dead.value).toEqual(undecodable.value);

    await waitFor(() => settled.length === 1);
    expect(settled[0]!.context.eventId).toBe("55555555-5555-4555-8555-555555555555");
    expect(errors).toHaveBeenCalledWith(expect.stringContaining("undecodable"));

    await consumer.stop();
    await dlt.stop();
  });

  it("dead-letters a schema violation under its own reason, ladder skipped", async () => {
    const errors = jest.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
    const { bus, settled } = busThat(() => []);
    const dlt = await readDeadLetters();
    const consumer = await start(bus);

    // Our headers, our event name, a payload missing a required field: a
    // producer of this event emitting the wrong shape, which is a different
    // problem with a different owner from a foreign producer's bytes.
    const valid = encodeDomainEvent(TOPIC, event, contract);
    await broker.produce([
      { ...valid, value: Buffer.from(JSON.stringify({ userId: "user-1" }), "utf8") },
      encodeDomainEvent(
        TOPIC,
        { ...event, eventId: "66666666-6666-4666-8666-666666666666" },
        contract,
      ),
    ]);

    await waitFor(() => dlt.received.length === 1);
    const dead = dlt.received[0]!;
    expect(dead.headers[DEAD_LETTER_HEADERS.reason]).toBe("schema-invalid");
    expect(dead.headers[DEAD_LETTER_HEADERS.errorType]).toBe("SchemaContractViolationError");
    // One attempt, for the same reason an undecodable message gets one: a
    // payload that violates the contract does not start conforming on a reread.
    expect(dead.headers[DEAD_LETTER_HEADERS.attempts]).toBe("1");
    // Enough to act on without opening the payload.
    expect(dead.headers[DEAD_LETTER_HEADERS.error]).toMatch(/written by v1, rejected by v1/);
    // The event behind it on the same partition is not held up.
    await waitFor(() => settled.length === 1);
    expect(settled[0]!.context.eventId).toBe("66666666-6666-4666-8666-666666666666");
    expect(errors).toHaveBeenCalled();

    await consumer.stop();
    await dlt.stop();
  });

  it("does not commit when the dead letter could not be produced", async () => {
    jest.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    const { bus, settled } = busThat(() => ["WelcomeEmailListener.onUserRegistered"]);
    const unreachable = {
      produce: async (): Promise<void> => {
        throw new Error("brokers unreachable");
      },
    } as unknown as MessageBroker;
    const consumer = await start(bus, { deadLetters: new DeadLetterQueue(unreachable, DLT) });

    await broker.produce([encodeDomainEvent(TOPIC, event, contract)]);

    // Past one whole ladder: the message is redelivered and the ladder runs
    // again. Committing here would delete a message the consumer had given up
    // on *and* failed to copy anywhere — silent loss on the exact path that
    // exists to prevent it.
    await waitFor(() => settled.length > 3);

    await consumer.stop();
  });

  it("blocks the partition rather than dropping a message when dead-lettering is off", async () => {
    const errors = jest.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    const { bus, settled } = busThat(() => ["WelcomeEmailListener.onUserRegistered"]);
    // No topic — `KAFKA_DEAD_LETTER_ENABLED=false`, which is the behaviour from
    // before this item and is still a defensible choice for a stream where a
    // gap is worse than a stall.
    const consumer = await start(bus, { deadLetters: new DeadLetterQueue(broker) });

    await broker.produce([encodeDomainEvent(TOPIC, event, contract)]);
    await waitFor(() => settled.length > 3);

    expect(errors).toHaveBeenCalledWith(expect.stringContaining("KAFKA_DEAD_LETTER_ENABLED=false"));

    await consumer.stop();
  });

  it("stops promptly during a ladder instead of waiting the backoff out", async () => {
    jest.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    const { bus, settled } = busThat(() => ["WelcomeEmailListener.onUserRegistered"]);
    const consumer = await start(bus, {
      // A minute per rung, at the top of it. Without the abort in `stop()`,
      // shutdown would wait out the whole ladder — per partition — and the
      // orchestrator would `SIGKILL` the pod mid-request instead.
      config: configWith({ KAFKA_RETRY_BASE_MS: 60_000, KAFKA_RETRY_MAX_DELAY_MS: 60_000 }),
      random: () => 0.999_999,
    });

    await broker.produce([encodeDomainEvent(TOPIC, event, contract)]);
    await waitFor(() => settled.length === 1);

    const started = Date.now();
    await consumer.stop();
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("reads nothing when disabled", async () => {
    const { bus, settled } = busThat(() => []);
    const consumer = await start(bus, { config: configWith({ KAFKA_CONSUMER_ENABLED: false }) });

    await broker.produce([encodeDomainEvent(TOPIC, event, contract)]);
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(settled).toHaveLength(0);
    // Destroying a consumer that never subscribed must not throw — a producer-
    // only replica shuts down through this path on every deploy.
    await expect(consumer.stop()).resolves.toBeUndefined();
  });
});

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("timed out");
}
