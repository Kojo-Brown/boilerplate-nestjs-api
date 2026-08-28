import { Logger } from "@nestjs/common";
import { DeadLetterQueue } from "./dead-letter-queue.service";
import { DEAD_LETTER_HEADERS } from "./dead-letter";
import { DeadLetterPublishError } from "./messaging.errors";
import { InMemoryBroker } from "./in-memory-broker";
import type { DeadLetterContext } from "./dead-letter";
import type { IncomingMessage, MessageBroker, OutgoingMessage } from "./ports";

const DLT = "domain-events.dlt";

const message: IncomingMessage = {
  topic: "domain-events",
  partition: 0,
  offset: "7",
  key: "user-1",
  value: Buffer.from('{"userId":"user-1"}', "utf8"),
  headers: {},
  timestamp: new Date("2026-08-27T10:00:00.000Z"),
};

const context: DeadLetterContext = {
  groupId: "spec-group",
  reason: "handler-failed",
  attempts: 4,
  error: new Error("subscriber failed"),
  failedAt: new Date("2026-08-27T10:00:05.000Z"),
};

describe("DeadLetterQueue", () => {
  let broker: InMemoryBroker;
  let errors: jest.SpyInstance;

  beforeEach(async () => {
    broker = new InMemoryBroker({ defaultPartitions: 1 });
    await broker.connect();
    errors = jest.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
  });

  afterEach(async () => {
    await broker.disconnect();
    jest.restoreAllMocks();
  });

  it("produces the message to the dead-letter topic", async () => {
    const queue = new DeadLetterQueue(broker, DLT);
    const read: IncomingMessage[] = [];
    const subscription = await broker.subscribe({
      groupId: "dlt-reader",
      topics: [DLT],
      fromBeginning: true,
      handle: async (received) => {
        read.push(received);
      },
    });

    await queue.send(message, context);
    await waitFor(() => read.length === 1);

    expect(read[0]!.value.toString("utf8")).toBe('{"userId":"user-1"}');
    expect(read[0]!.key).toBe("user-1");
    expect(read[0]!.headers[DEAD_LETTER_HEADERS.originOffset]).toBe("7");
    await subscription.stop();
  });

  it("logs at error, because a dead letter needs a human", async () => {
    await new DeadLetterQueue(broker, DLT).send(message, context);

    expect(errors).toHaveBeenCalledWith(expect.stringContaining("Dead-lettered domain-events/0@7"));
    expect(errors).toHaveBeenCalledWith(expect.stringContaining("subscriber failed"));
  });

  it("reports a failed produce rather than swallowing it", async () => {
    const failing = {
      ...broker,
      name: "memory" as const,
      produce: async (_messages: readonly OutgoingMessage[]): Promise<void> => {
        throw new Error("brokers unreachable");
      },
    } as unknown as MessageBroker;

    // The caller must not commit when this rejects: the consumer has stopped
    // trying to handle the message, so committing without a copy anywhere would
    // delete it outright.
    const send = new DeadLetterQueue(failing, DLT).send(message, context);
    await expect(send).rejects.toBeInstanceOf(DeadLetterPublishError);
    await expect(send).rejects.toThrow("brokers unreachable");
  });

  it("does not log a dead letter it failed to send", async () => {
    const failing = {
      produce: async (): Promise<void> => {
        throw new Error("brokers unreachable");
      },
    } as unknown as MessageBroker;

    await expect(new DeadLetterQueue(failing, DLT).send(message, context)).rejects.toThrow();

    // "Dead-lettered X" in the log when nothing was written is how an operator
    // ends up looking for a record that does not exist.
    expect(errors).not.toHaveBeenCalledWith(expect.stringContaining("Dead-lettered"));
  });

  it("is disabled when it has no topic, and says so rather than dropping a message", async () => {
    const queue = new DeadLetterQueue(broker);

    expect(queue.enabled).toBe(false);
    // Not a silent no-op: a no-op here would make an exhausted ladder drop the
    // message, which is the one outcome nothing in this design ever chooses.
    await expect(queue.send(message, context)).rejects.toThrow("Check `enabled` first");
  });

  it("is enabled when it has one", () => {
    expect(new DeadLetterQueue(broker, DLT).enabled).toBe(true);
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
