import type { OutboxRecord } from "@/outbox";
import { InMemoryBroker } from "./in-memory-broker";
import { BrokerOutboxPublisher } from "./broker-outbox.publisher";
import { EVENT_HEADERS, decodeDomainEvent } from "./domain-event-codec";
import type { IncomingMessage } from "./ports";

const TOPIC = "domain-events";

const record: OutboxRecord = {
  id: "row-1",
  name: "user.registered",
  payload: { userId: "user-1", email: "ada@example.test", name: "Ada", provider: "google" },
  eventId: "22222222-2222-4222-8222-222222222222",
  correlationId: "req-9",
  occurredAt: new Date("2026-08-27T09:30:00.000Z"),
  attempts: 0,
};

describe("BrokerOutboxPublisher", () => {
  let broker: InMemoryBroker;
  let publisher: BrokerOutboxPublisher;

  beforeEach(async () => {
    broker = new InMemoryBroker({ defaultPartitions: 1 });
    publisher = new BrokerOutboxPublisher(broker, TOPIC);
    await broker.connect();
  });

  afterEach(async () => {
    await broker.disconnect();
  });

  it("names itself for the backend and the topic", () => {
    // This string is what the relay logs at startup and what a dead-letter row
    // records. "broker" would leave an operator unable to tell a real cluster
    // from the in-process double.
    expect(publisher.name).toBe("memory:domain-events");
  });

  it("produces the record so a consumer decodes the same event back", async () => {
    const seen: IncomingMessage[] = [];
    await broker.subscribe({
      groupId: "spec",
      topics: [TOPIC],
      fromBeginning: true,
      handle: async (message) => {
        seen.push(message);
      },
    });

    await publisher.publish(record);
    await waitFor(() => seen.length === 1);

    const decoded = decodeDomainEvent(seen[0]!);
    expect(decoded.name).toBe("user.registered");
    expect(decoded.payload).toEqual(record.payload);
    // The identity minted inside the transaction, unchanged. It is the only
    // thing a consumer can deduplicate on, and both halves of this pipeline
    // deliver at least once.
    expect(decoded.eventId).toBe(record.eventId);
    expect(decoded.occurredAt).toEqual(record.occurredAt);
    expect(decoded.correlationId).toBe("req-9");
  });

  it("partitions on the aggregate, not on the event id", async () => {
    const seen: IncomingMessage[] = [];
    await broker.subscribe({
      groupId: "spec-keys",
      topics: [TOPIC],
      fromBeginning: true,
      handle: async (message) => {
        seen.push(message);
      },
    });

    await publisher.publish(record);
    await publisher.publish({
      ...record,
      id: "row-2",
      eventId: "33333333-3333-4333-8333-333333333333",
      name: "user.deleted",
      payload: { userId: "user-1", email: "ada@example.test" },
    });
    await waitFor(() => seen.length === 2);

    // Same user, same key, therefore same partition and therefore ordered.
    // Keyed on the event id instead, `user.deleted` could arrive first.
    expect(seen.map((message) => message.key)).toEqual(["user-1", "user-1"]);
    expect(seen.map((message) => message.headers[EVENT_HEADERS.name])).toEqual([
      "user.registered",
      "user.deleted",
    ]);
  });

  it("rejects when the broker does, so the relay retries the row", async () => {
    await broker.disconnect();
    // The relay marks a row `PUBLISHED` on a resolved promise, so a publisher
    // that swallowed a broker failure would lose the event and report success.
    await expect(publisher.publish(record)).rejects.toThrow(/disconnected/);
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
