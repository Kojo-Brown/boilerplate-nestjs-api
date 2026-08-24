import { ConfigService } from "@nestjs/config";
import { InMemoryOutboxStore } from "@/test-utils/in-memory-outbox.store";
import { InMemoryTransactionRunner } from "@/test-utils/in-memory-transaction.runner";
import { OutboxRelayService } from "./outbox-relay.service";
import { PublishTimeoutError } from "./outbox.errors";
import type { OutboxPublisher } from "./ports";
import type { OutboxRecord } from "./outbox-record";

const SETTINGS: Record<string, unknown> = {
  OUTBOX_RELAY_ENABLED: true,
  OUTBOX_POLL_INTERVAL_MS: 5,
  OUTBOX_BATCH_SIZE: 10,
  OUTBOX_PUBLISH_TIMEOUT_MS: 50,
  OUTBOX_BACKOFF_BASE_MS: 1_000,
  OUTBOX_BACKOFF_MAX_MS: 60_000,
  OUTBOX_MAX_ATTEMPTS: 3,
};

function configWith(overrides: Record<string, unknown> = {}): ConfigService {
  const settings = { ...SETTINGS, ...overrides };
  return {
    get: <T>(key: string, fallback: T): T => (settings[key] as T | undefined) ?? fallback,
  } as unknown as ConfigService;
}

/** A publisher whose behaviour each test dictates. */
class ScriptedPublisher implements OutboxPublisher {
  readonly name = "scripted";
  readonly seen: OutboxRecord[] = [];
  behaviour: (record: OutboxRecord) => Promise<void> = () => Promise.resolve();

  publish(record: OutboxRecord): Promise<void> {
    this.seen.push(record);
    return this.behaviour(record);
  }
}

describe("OutboxRelayService", () => {
  let store: InMemoryOutboxStore;
  let transactions: InMemoryTransactionRunner;
  let publisher: ScriptedPublisher;

  const relay = (overrides: Record<string, unknown> = {}, random = () => 0.5) =>
    new OutboxRelayService(store, publisher, configWith(overrides), random);

  const stage = async (eventId: string, occurredAt = new Date(Date.now() - 1_000)) => {
    await transactions.run((tx) =>
      store.stage(tx, {
        eventId,
        name: "user.registered",
        payload: { userId: "user-1", email: "relay@example.test", name: null, provider: null },
        correlationId: null,
        occurredAt,
      }),
    );
  };

  beforeEach(() => {
    store = new InMemoryOutboxStore();
    transactions = new InMemoryTransactionRunner();
    publisher = new ScriptedPublisher();
  });

  describe("runOnce()", () => {
    it("publishes what is due and reports it", async () => {
      await stage("evt-1");

      const report = await relay().runOnce();

      expect(publisher.seen.map((r) => r.eventId)).toEqual(["evt-1"]);
      expect(report).toMatchObject({
        claimed: 1,
        outcomes: [expect.objectContaining({ disposition: "published" })],
      });
    });

    it("does nothing, cheaply, when there is nothing due", async () => {
      const report = await relay().runOnce();

      expect(publisher.seen).toEqual([]);
      expect(report).toEqual({ claimed: 0, outcomes: [] });
    });

    it("schedules a failed event by the backoff ladder", async () => {
      await stage("evt-1");
      publisher.behaviour = () => Promise.reject(new Error("broker unreachable"));
      const now = new Date("2026-08-24T12:00:00.000Z");

      // First failure, `random` pinned at 0.5: half of the 1s base window.
      const report = await relay({}, () => 0.5).runOnce(now);

      expect(report.outcomes[0]).toMatchObject({
        disposition: "retry",
        nextAttemptAt: new Date("2026-08-24T12:00:00.500Z"),
      });
    });

    it("widens the window on each successive failure", async () => {
      // Staged at the epoch, so the passes below can run on a clock the
      // assertions can state exactly.
      await stage("evt-1", new Date(0));
      publisher.behaviour = () => Promise.reject(new Error("still down"));
      const relayUnderTest = relay({}, () => 0.5);

      const first = await relayUnderTest.runOnce(new Date(0));
      const second = await relayUnderTest.runOnce(new Date(first.outcomes[0]!.nextAttemptAt!));

      expect(first.outcomes[0]?.nextAttemptAt?.getTime()).toBe(500);
      // Second failure: 2 · base, halved by the pinned jitter, offset from the
      // moment this pass ran rather than from the first one.
      expect(second.outcomes[0]?.nextAttemptAt?.getTime()).toBe(500 + 1_000);
    });

    it("dead-letters once the attempts are spent, rather than retrying forever", async () => {
      await stage("evt-1", new Date(0));
      publisher.behaviour = () => Promise.reject(new Error("poison"));
      const relayUnderTest = relay({ OUTBOX_MAX_ATTEMPTS: 2 });

      const first = await relayUnderTest.runOnce(new Date(0));
      const second = await relayUnderTest.runOnce(new Date(first.outcomes[0]!.nextAttemptAt!));

      expect(first.outcomes[0]?.disposition).toBe("retry");
      expect(second.outcomes[0]?.disposition).toBe("dead");
      await expect(store.countByStatus()).resolves.toMatchObject({ DEAD: 1, PENDING: 0 });
    });

    /**
     * The timeout bounds the drain transaction, which is holding a row lock on
     * every event in the batch. Without it a broker that has stopped answering
     * makes the whole batch invisible to every other replica until the
     * transaction timeout fires much later.
     */
    it("treats a publish that does not answer as a failure", async () => {
      await stage("evt-1");
      publisher.behaviour = () => new Promise(() => {}); // never settles

      const report = await relay({ OUTBOX_PUBLISH_TIMEOUT_MS: 10 }).runOnce();

      expect(report.outcomes[0]).toMatchObject({
        disposition: "retry",
        error: expect.stringContaining("exceeded 10ms"),
      });
      await expect(store.countByStatus()).resolves.toMatchObject({ PENDING: 1 });
    });

    it("names the timeout it exceeded", async () => {
      await stage("evt-1");
      publisher.behaviour = () => new Promise(() => {});

      await expect(
        relay({ OUTBOX_PUBLISH_TIMEOUT_MS: 10 })["deliver"]({
          eventId: "evt-1",
        } as OutboxRecord),
      ).rejects.toThrow(PublishTimeoutError);
    });

    it("does not let one bad event hold up the rest of the batch", async () => {
      await stage("evt-1");
      await stage("evt-2");
      publisher.behaviour = (record) =>
        record.eventId === "evt-1" ? Promise.reject(new Error("just this one")) : Promise.resolve();

      const report = await relay().runOnce();

      expect(report.claimed).toBe(2);
      await expect(store.countByStatus()).resolves.toMatchObject({ PENDING: 1, PUBLISHED: 1 });
    });

    it("honours the configured batch size", async () => {
      await stage("evt-1");
      await stage("evt-2");
      await stage("evt-3");

      const report = await relay({ OUTBOX_BATCH_SIZE: 2 }).runOnce();

      expect(report.claimed).toBe(2);
    });
  });

  describe("the timer", () => {
    it("starts polling at bootstrap and delivers without being asked", async () => {
      await stage("evt-1");
      const relayUnderTest = relay();

      relayUnderTest.onApplicationBootstrap();
      await waitFor(() => publisher.seen.length === 1);
      await relayUnderTest.onModuleDestroy();

      expect(publisher.seen.map((r) => r.eventId)).toEqual(["evt-1"]);
    });

    it("stays inert when the relay is disabled", async () => {
      await stage("evt-1");
      const relayUnderTest = relay({ OUTBOX_RELAY_ENABLED: false });

      relayUnderTest.onApplicationBootstrap();
      await new Promise((resolve) => setTimeout(resolve, 30));
      await relayUnderTest.onModuleDestroy();

      expect(publisher.seen).toEqual([]);
    });

    /**
     * A drain in flight holds a transaction with rows locked in it. Shutting
     * down without waiting leaves Postgres to notice the dropped connection,
     * and the batch stays claimed until it does.
     */
    it("waits for the drain in flight before it shuts down", async () => {
      await stage("evt-1");
      let finished = false;
      publisher.behaviour = async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        finished = true;
      };
      const relayUnderTest = relay();

      relayUnderTest.onApplicationBootstrap();
      await waitFor(() => publisher.seen.length === 1);
      await relayUnderTest.onModuleDestroy();

      expect(finished).toBe(true);
    });

    it("keeps polling after a drain throws outright", async () => {
      const failing = {
        drain: jest
          .fn()
          .mockRejectedValueOnce(new Error("database unreachable"))
          .mockResolvedValue({ claimed: 0, outcomes: [] }),
        stage: jest.fn(),
        countByStatus: jest.fn(),
      };
      const relayUnderTest = new OutboxRelayService(failing, publisher, configWith(), () => 0.5);

      relayUnderTest.onApplicationBootstrap();
      await waitFor(() => failing.drain.mock.calls.length >= 2);
      await relayUnderTest.onModuleDestroy();

      expect(failing.drain.mock.calls.length).toBeGreaterThanOrEqual(2);
    });

    it("schedules no further tick once it has been destroyed", async () => {
      const relayUnderTest = relay();
      relayUnderTest.onApplicationBootstrap();
      await relayUnderTest.onModuleDestroy();

      await stage("evt-1");
      await new Promise((resolve) => setTimeout(resolve, 30));

      expect(publisher.seen).toEqual([]);
    });
  });
});

async function waitFor(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for the relay");
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}
