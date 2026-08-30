import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { createTestApp, type RecordingEmailQueue, type TestApp } from "./helpers/create-test-app";
import {
  DEAD_LETTER_HEADERS,
  DEAD_LETTER_TOPIC,
  EVENT_HEADERS,
  InMemoryBroker,
  MESSAGE_BROKER,
  encodeDomainEvent,
} from "@/messaging";
import type { IncomingMessage, MessageBroker } from "@/messaging";
import { EventContract } from "@/schema-registry";

/**
 * The whole pipeline, through the wiring a deployment actually runs.
 *
 * Every stage of it is covered somewhere else — `outbox-store.contract.ts` for
 * the row, `outbox-relay.service.spec.ts` for the claim and the ladder,
 * `message-broker.contract.ts` for the topic and the commits, and
 * `domain-event-consumer.service.spec.ts` for the far end. What none of them can
 * show is that the stages are connected: that a `POST /v1/auth/register` writes
 * an outbox row in the same transaction as the user, that the relay produces it
 * to the topic rather than to the in-process bus, that a consumer group reads it
 * back, and that `WelcomeEmailListener` — a subscriber written before there was
 * a broker, and unchanged by there being one — still runs.
 *
 * That last part is the point of the whole item. The event now leaves the
 * process and comes back, and nothing downstream of `DomainEventBus` can tell.
 */
describe("Messaging (e2e)", () => {
  let app: INestApplication;
  let emails: RecordingEmailQueue;
  let drainOutbox: TestApp["drainOutbox"];
  let broker: MessageBroker;
  /**
   * Taken from the container rather than built here, so these produce calls go
   * through the very contract the application validates with — a registry the
   * app failed to wire would fail this suite rather than being papered over.
   */
  let contract: EventContract;

  const previous = {
    publisher: process.env["OUTBOX_PUBLISHER"],
    backend: process.env["MESSAGE_BROKER"],
  };

  beforeAll(async () => {
    // The one e2e suite that runs the relay through the broker. The default is
    // `bus`, and the rest of the suite deliberately leaves it there — this spec
    // exists to cover the other binding, not to change what the others test.
    process.env["OUTBOX_PUBLISHER"] = "broker";
    process.env["MESSAGE_BROKER"] = "memory";

    const fixture: TestApp = await createTestApp();
    app = fixture.app;
    emails = fixture.emails;
    drainOutbox = fixture.drainOutbox;
    broker = app.get<MessageBroker>(MESSAGE_BROKER);
    contract = app.get(EventContract);
  });

  afterAll(async () => {
    await app.close();
    process.env["OUTBOX_PUBLISHER"] = previous.publisher;
    process.env["MESSAGE_BROKER"] = previous.backend;
  });

  beforeEach(() => {
    emails.reset();
  });

  it("carries a registration through the outbox, the topic and back onto the bus", async () => {
    const response = await request(app.getHttpServer()).post("/v1/auth/register").send({
      email: "kafka-e2e@example.test",
      password: process.env["E2E_TEST_PASSWORD"]!,
      name: "Grace",
    });
    expect(response.status).toBe(201);

    // Nothing yet. The event is a committed row and no more — which is the
    // latency the outbox trades for durability, made explicit rather than slept
    // through, exactly as `docs/outbox.md` describes.
    expect(emails.enqueued).toHaveLength(0);

    const report = await drainOutbox();
    expect(report.claimed).toBe(1);
    expect(report.outcomes[0]).toMatchObject({ disposition: "published" });

    // A published row means the *broker* accepted it, not that a subscriber ran
    // — the two are different moments now, which they were not when the relay
    // published straight to the bus. The consumer is reading the topic on its
    // own and the assertion has to wait for it.
    await waitFor(() => emails.enqueued.some((entry) => entry.job === "send-welcome"));

    const welcome = emails.enqueued.find((entry) => entry.job === "send-welcome");
    expect(welcome?.data).toMatchObject({ to: "kafka-e2e@example.test" });
  });

  it("is reading the topic as a consumer group, not by holding a reference to the bus", async () => {
    // Produced straight to the broker, bypassing the outbox and the relay
    // entirely. If the welcome email still goes out, the consumer really is
    // subscribed to the topic — a `DomainEventConsumer` that had quietly been
    // wired to the in-process bus would not see this at all.
    await broker.produce([
      encodeDomainEvent(
        process.env["KAFKA_DOMAIN_EVENTS_TOPIC"] ?? "domain-events",
        {
          name: "user.registered",
          payload: {
            userId: "direct-1",
            email: "direct@example.test",
            name: "Direct",
            provider: null,
          },
          eventId: "66666666-6666-4666-8666-666666666666",
          occurredAt: new Date(),
          correlationId: null,
        },
        contract,
      ),
    ]);

    await waitFor(() => emails.enqueued.some((entry) => entry.job === "send-welcome"));
    expect(emails.enqueued.find((entry) => entry.job === "send-welcome")?.data).toMatchObject({
      to: "direct@example.test",
    });
  });

  it("dead-letters a message it cannot handle and keeps reading the partition", async () => {
    const topic = process.env["KAFKA_DOMAIN_EVENTS_TOPIC"] ?? "domain-events";
    // Resolved from the container, not rebuilt here: this asserts the topic the
    // application actually derived and created at bootstrap, which is the half a
    // unit test cannot reach.
    const deadLetterTopic = app.get<string | null>(DEAD_LETTER_TOPIC);
    expect(deadLetterTopic).toBe(`${topic}.dlt`);

    const dead: IncomingMessage[] = [];
    const reader = await broker.subscribe({
      groupId: "e2e-dlt-reader",
      topics: [deadLetterTopic!],
      fromBeginning: true,
      handle: async (message) => {
        dead.push(message);
      },
    });

    const good = encodeDomainEvent(
      topic,
      {
        name: "user.registered",
        payload: {
          userId: "poison-1",
          email: "behind-the-poison@example.test",
          name: "Behind",
          provider: null,
        },
        eventId: "77777777-7777-4777-8777-777777777777",
        occurredAt: new Date(),
        correlationId: null,
      },
      contract,
    );

    await broker.produce([
      // An event name no build of this service knows. Same key as the message
      // behind it, so both land on the same partition and the second cannot be
      // handled until the first is dealt with — which, before there was a
      // dead-letter topic, meant dropping the first outright.
      { ...good, headers: { ...good.headers, [EVENT_HEADERS.name]: "user.renamed" } },
      good,
    ]);

    await waitFor(() => dead.length === 1);
    expect(dead[0]!.headers[DEAD_LETTER_HEADERS.reason]).toBe("undecodable");
    expect(dead[0]!.headers[DEAD_LETTER_HEADERS.originTopic]).toBe(topic);
    expect(dead[0]!.headers[DEAD_LETTER_HEADERS.errorType]).toBe("UndecodableMessageError");

    // And the partition moved on: the well-formed event behind the poison one
    // reached its subscriber.
    await waitFor(() =>
      emails.enqueued.some(
        (entry) => (entry.data as { to?: string }).to === "behind-the-poison@example.test",
      ),
    );

    await reader.stop();
  });

  it("dead-letters a payload that violates the schema contract, through the real wiring", async () => {
    const topic = process.env["KAFKA_DOMAIN_EVENTS_TOPIC"] ?? "domain-events";
    const deadLetterTopic = app.get<string | null>(DEAD_LETTER_TOPIC);

    const dead: IncomingMessage[] = [];
    const reader = await broker.subscribe({
      groupId: "e2e-schema-dlt-reader",
      topics: [deadLetterTopic!],
      fromBeginning: true,
      handle: async (message) => {
        dead.push(message);
      },
    });

    const wellFormed = encodeDomainEvent(
      topic,
      {
        name: "user.registered",
        payload: {
          userId: "contract-1",
          email: "behind-the-violation@example.test",
          name: "Behind",
          provider: null,
        },
        eventId: "88888888-8888-4888-8888-888888888888",
        occurredAt: new Date(),
        correlationId: null,
      },
      contract,
    );

    await broker.produce([
      // Our headers and our event name, with a payload missing `email` — the
      // shape a producer that skipped a schema version would emit. This is the
      // half the unit suite cannot reach: that the registry the application
      // wired at boot is the one the running consumer validates with.
      {
        ...wellFormed,
        value: Buffer.from(JSON.stringify({ userId: "contract-1" }), "utf8"),
      },
      wellFormed,
    ]);

    // Searched rather than indexed: this reader starts from the beginning of a
    // topic the previous spec already dead-lettered to, so position 0 is that
    // spec's message and not this one's.
    const violation = (): IncomingMessage | undefined =>
      dead.find((m) => m.headers[DEAD_LETTER_HEADERS.reason] === "schema-invalid");
    await waitFor(() => violation() !== undefined);
    expect(violation()!.headers[DEAD_LETTER_HEADERS.errorType]).toBe(
      "SchemaContractViolationError",
    );
    expect(violation()!.headers[DEAD_LETTER_HEADERS.error]).toMatch(/email/);
    expect(violation()!.headers[DEAD_LETTER_HEADERS.originTopic]).toBe(topic);

    // And the partition moved on.
    await waitFor(() =>
      emails.enqueued.some(
        (entry) => (entry.data as { to?: string }).to === "behind-the-violation@example.test",
      ),
    );

    await reader.stop();
  });

  it("uses the in-memory broker the environment selected", () => {
    // The e2e suite runs the whole application on doubles, and this is the one
    // that would otherwise open a socket to a cluster that is not there.
    expect(broker).toBeInstanceOf(InMemoryBroker);
    expect(broker.name).toBe("memory");
  });
});

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("timed out waiting for the consumer to handle the event");
}
