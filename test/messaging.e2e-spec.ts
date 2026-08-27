import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { createTestApp, type RecordingEmailQueue, type TestApp } from "./helpers/create-test-app";
import { InMemoryBroker, MESSAGE_BROKER, encodeDomainEvent } from "@/messaging";
import type { MessageBroker } from "@/messaging";

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
      encodeDomainEvent(process.env["KAFKA_DOMAIN_EVENTS_TOPIC"] ?? "domain-events", {
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
      }),
    ]);

    await waitFor(() => emails.enqueued.some((entry) => entry.job === "send-welcome"));
    expect(emails.enqueued.find((entry) => entry.job === "send-welcome")?.data).toMatchObject({
      to: "direct@example.test",
    });
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
