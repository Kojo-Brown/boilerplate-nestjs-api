import { InMemoryBroker } from "./in-memory-broker";
import { BrokerClosedError } from "./messaging.errors";

/**
 * What `message-broker.contract.ts` cannot reach.
 *
 * The contract covers the behaviour both backends share, which is where nearly
 * every assertion about this class belongs. What is left here is the double's
 * own surface: the closed-broker guard, and `committedOffsets`, which exists
 * only so a spec can look at the bookkeeping directly rather than infer it from
 * a rejoin.
 */
describe("InMemoryBroker", () => {
  let broker: InMemoryBroker;

  beforeEach(() => {
    broker = new InMemoryBroker({ defaultPartitions: 2 });
  });

  afterEach(async () => {
    await broker.disconnect();
  });

  it("creates a topic implicitly on first produce, at the default partition count", async () => {
    await broker.connect();
    const partitions = new Set<number>();
    await broker.subscribe({
      groupId: "g",
      topics: ["implicit"],
      fromBeginning: true,
      handle: async (message) => {
        partitions.add(message.partition);
      },
    });

    await broker.produce(
      ["a", "b", "c", "d", "e", "f"].map((key) => ({
        topic: "implicit",
        key,
        value: Buffer.from(key),
        headers: {},
      })),
    );
    await waitFor(() => partitions.size >= 2);
    expect(partitions.size).toBe(2);
  });

  it("leaves an existing topic's partition count alone", async () => {
    await broker.ensureTopics([{ topic: "fixed", partitions: 1 }]);
    // Raising it here would re-hash every key to a different partition, which
    // silently breaks ordering for the ones that move. A real cluster refuses
    // to lower it at all, so the double refuses to change it either way.
    await broker.ensureTopics([{ topic: "fixed", partitions: 8 }]);

    const partitions = new Set<number>();
    await broker.subscribe({
      groupId: "g-fixed",
      topics: ["fixed"],
      fromBeginning: true,
      handle: async (message) => {
        partitions.add(message.partition);
      },
    });
    await broker.produce(
      ["a", "b", "c", "d"].map((key) => ({
        topic: "fixed",
        key,
        value: Buffer.from(key),
        headers: {},
      })),
    );
    await waitFor(() => partitions.size >= 1);
    expect([...partitions]).toEqual([0]);
  });

  it("records the offset after the handled one, per group and partition", async () => {
    await broker.ensureTopics([{ topic: "offsets", partitions: 1 }]);
    let handled = 0;
    await broker.subscribe({
      groupId: "g-offsets",
      topics: ["offsets"],
      fromBeginning: true,
      handle: async () => {
        handled += 1;
      },
    });

    await broker.produce([
      { topic: "offsets", key: "k", value: Buffer.from("1"), headers: {} },
      { topic: "offsets", key: "k", value: Buffer.from("2"), headers: {} },
    ]);
    await waitFor(() => handled === 2);

    // Two messages at offsets 0 and 1, so the next one to read is 2 — not 1,
    // which is the off-by-one that replays the last message of every partition
    // forever.
    expect(broker.committedOffsets("g-offsets").get("offsets#0")).toBe("2");
  });

  it("reports no offsets for a group that never ran", () => {
    expect(broker.committedOffsets("never").size).toBe(0);
  });

  it.each([
    ["connect", async (b: InMemoryBroker) => b.connect()],
    ["ensureTopics", async (b: InMemoryBroker) => b.ensureTopics([{ topic: "t", partitions: 1 }])],
    ["produce", async (b: InMemoryBroker) => b.produce([])],
    [
      "subscribe",
      async (b: InMemoryBroker) =>
        b.subscribe({ groupId: "g", topics: ["t"], fromBeginning: true, handle: async () => {} }),
    ],
  ])("refuses %s after disconnect", async (operation, call) => {
    await broker.connect();
    await broker.disconnect();
    await expect(call(broker)).rejects.toThrow(BrokerClosedError);
    await expect(call(broker)).rejects.toThrow(operation);
  });

  it("is safe to disconnect twice", async () => {
    await broker.connect();
    await broker.disconnect();
    await expect(broker.disconnect()).resolves.toBeUndefined();
  });

  it("is safe to stop a subscription twice", async () => {
    await broker.connect();
    const subscription = await broker.subscribe({
      groupId: "g-twice",
      topics: ["t"],
      fromBeginning: true,
      handle: async () => {},
    });
    await subscription.stop();
    await expect(subscription.stop()).resolves.toBeUndefined();
  });

  it("gives a member joining with fromBeginning=false only what arrives next", async () => {
    await broker.ensureTopics([{ topic: "latest", partitions: 1 }]);
    await broker.produce([
      { topic: "latest", key: "k", value: Buffer.from("before"), headers: {} },
    ]);

    const seen: string[] = [];
    await broker.subscribe({
      groupId: "g-latest",
      topics: ["latest"],
      fromBeginning: false,
      handle: async (message) => {
        seen.push(message.value.toString("utf8"));
      },
    });
    await broker.produce([{ topic: "latest", key: "k", value: Buffer.from("after"), headers: {} }]);

    await waitFor(() => seen.length === 1);
    expect(seen).toEqual(["after"]);
  });

  it("moves a partition to the surviving member when one leaves", async () => {
    await broker.ensureTopics([{ topic: "handover", partitions: 2 }]);
    const first: string[] = [];
    const second: string[] = [];
    const leaving = await broker.subscribe({
      groupId: "g-handover",
      topics: ["handover"],
      fromBeginning: true,
      handle: async (message) => {
        first.push(message.value.toString("utf8"));
      },
    });
    await broker.subscribe({
      groupId: "g-handover",
      topics: ["handover"],
      fromBeginning: true,
      handle: async (message) => {
        second.push(message.value.toString("utf8"));
      },
    });

    await leaving.stop();
    // With one member left, it holds both partitions — which is what makes a
    // replica dying a pause rather than a gap.
    await broker.produce(
      ["a", "b", "c", "d", "e", "f"].map((key) => ({
        topic: "handover",
        key,
        value: Buffer.from(key),
        headers: {},
      })),
    );

    await waitFor(() => second.length === 6);
    expect(second.sort()).toEqual(["a", "b", "c", "d", "e", "f"]);
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
