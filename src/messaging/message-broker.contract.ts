import type { IncomingMessage, MessageBroker, RunningSubscription } from "./ports";
import { nextOffset } from "./ports";

/**
 * The behavioural contract every `MessageBroker` implementation must satisfy.
 *
 * `MESSAGE_BROKER` picks the backend from the environment, so everything
 * downstream — `BrokerOutboxPublisher`, `DomainEventConsumer`, and any handler
 * either of them reaches — behaves the same whether CI is running the in-memory
 * double or a real cluster (LSP). What is pinned here is the five properties
 * the rest of the repository is written against, and no more:
 *
 *   1. A produced message reaches a subscriber of a group on that topic.
 *   2. Messages sharing a key arrive in the order they were produced.
 *   3. Two groups each get every message; two members of one group split them.
 *   4. A handler that rejects does not commit, and the message comes back.
 *   5. A handler that resolves does commit, so a new member does not re-read it.
 *
 * Properties 4 and 5 together are "manual offset commits" stated as something a
 * caller can observe, which is the only form in which they are worth asserting:
 * a test that reached into the adapter to check `commitOffsets` was called would
 * pass just as happily against a commit of the wrong offset — the bug that
 * replays the last message of every partition forever.
 *
 * Timing is the one thing the two backends genuinely differ on: the double
 * delivers within a tick, a real cluster within a fetch cycle. Every assertion
 * here polls to a deadline rather than sleeping a fixed amount, so the same
 * spec is neither flaky on a slow runner nor slow on a fast one.
 */
export interface MessageBrokerHarness {
  readonly broker: MessageBroker;
  /**
   * How long an assertion waits for a message. Seconds against a real cluster,
   * milliseconds against the double — a fetch cycle plus a rebalance is not a
   * cost the double has.
   */
  readonly deadlineMs: number;
  /**
   * A topic name nothing else is using.
   *
   * Per-harness rather than a constant, because a real cluster keeps its topics
   * between runs: two specs sharing a name would share a log, and a group would
   * read the previous run's messages. The double has no such problem, which is
   * precisely why the constant would have looked fine.
   */
  topic(suffix: string): string;
  /**
   * The handler bound the harness configured its broker with, so the contract
   * can wait past it rather than guess.
   */
  readonly handlerTimeoutMs: number;
}

const POLL_INTERVAL_MS = 5;

export function describeMessageBrokerContract(
  name: string,
  createHarness: () => Promise<MessageBrokerHarness>,
  teardown: (harness: MessageBrokerHarness) => Promise<void>,
  /**
   * Per-test timeout. Has to exceed the harness deadline, or a spec that is
   * legitimately waiting on a rebalance fails as a Jest timeout with no message
   * saying what it was waiting for — which is the least useful way for a broker
   * problem to be reported.
   */
  timeoutMs = 10_000,
): void {
  /** `it` with the contract's timeout applied, so no spec can forget it. */
  const spec = (description: string, body: () => Promise<void>): void => {
    it(description, body, timeoutMs);
  };

  describe(`${name} (message broker contract)`, () => {
    let harness: MessageBrokerHarness;
    let broker: MessageBroker;
    let started: RunningSubscription[];

    // The timeout is passed to the hooks as well as to the specs, and that is
    // not defensive padding. Jest times hooks separately, at a flat 5s that a
    // per-test timeout does not touch, and leaving a consumer group on a real
    // cluster costs about that on its own — a fetch in flight is waiting up to
    // `maxWaitTimeInMs` before it can be cancelled. Without this the teardown
    // times out with the consumer still connected, so it keeps its partitions
    // until the session expires and every following spec waits for a group it
    // cannot be assigned anything from. The symptom is a suite that stops
    // producing output rather than a failure that names the hook.
    beforeEach(async () => {
      harness = await createHarness();
      broker = harness.broker;
      started = [];
      await broker.connect();
    }, timeoutMs);

    afterEach(async () => {
      // Stopped before teardown so a member leaves its group cleanly; a real
      // cluster otherwise holds the partitions until the session times out,
      // and the next spec's group waits that long to be assigned anything.
      await Promise.all(started.map((subscription) => subscription.stop()));
      await teardown(harness);
    }, timeoutMs);

    /** Subscribes and remembers the subscription so `afterEach` can stop it. */
    async function subscribe(
      groupId: string,
      topics: readonly string[],
      handle: (message: IncomingMessage) => Promise<void>,
      fromBeginning = true,
    ): Promise<RunningSubscription> {
      const subscription = await broker.subscribe({ groupId, topics, fromBeginning, handle });
      started.push(subscription);
      return subscription;
    }

    async function until(predicate: () => boolean, what: string): Promise<void> {
      const deadline = Date.now() + harness.deadlineMs;
      while (Date.now() < deadline) {
        if (predicate()) return;
        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
      }
      throw new Error(`Timed out after ${harness.deadlineMs}ms waiting for: ${what}`);
    }

    function message(topic: string, key: string | null, body: string) {
      return { topic, key, value: Buffer.from(body, "utf8"), headers: { "test-body": body } };
    }

    describe("produce and subscribe", () => {
      spec("delivers a produced message to a subscriber, with its key and headers", async () => {
        const topic = harness.topic("delivers");
        await broker.ensureTopics([{ topic, partitions: 1 }]);

        const seen: IncomingMessage[] = [];
        await subscribe("g-delivers", [topic], async (received) => {
          seen.push(received);
        });
        await broker.produce([message(topic, "k1", "hello")]);

        await until(() => seen.length === 1, "one message");
        expect(seen[0]!.topic).toBe(topic);
        expect(seen[0]!.key).toBe("k1");
        expect(seen[0]!.value.toString("utf8")).toBe("hello");
        expect(seen[0]!.headers["test-body"]).toBe("hello");
        // Offsets are strings on the port for a reason; a number here would
        // mean the adapter had already converted and lost precision.
        expect(typeof seen[0]!.offset).toBe("string");
        expect(seen[0]!.timestamp).toBeInstanceOf(Date);
      });

      spec("preserves order between messages sharing a key", async () => {
        const topic = harness.topic("order");
        // Several partitions, so the ordering is a property of the key rather
        // than of there being nowhere else for a message to go.
        await broker.ensureTopics([{ topic, partitions: 3 }]);

        const seen: string[] = [];
        await subscribe("g-order", [topic], async (received) => {
          seen.push(received.value.toString("utf8"));
        });
        const bodies = ["1", "2", "3", "4", "5"];
        await broker.produce(bodies.map((body) => message(topic, "same-key", body)));

        await until(() => seen.length === bodies.length, "all five messages");
        expect(seen).toEqual(bodies);
      });

      spec("puts messages sharing a key on one partition", async () => {
        const topic = harness.topic("partitioning");
        await broker.ensureTopics([{ topic, partitions: 3 }]);

        const partitions = new Set<number>();
        let handled = 0;
        await subscribe("g-partitioning", [topic], async (received) => {
          partitions.add(received.partition);
          handled += 1;
        });
        await broker.produce(
          Array.from({ length: 6 }, (_unused, index) => message(topic, "sticky", String(index))),
        );

        // Every message, then the assertion. Asserting on the set as soon as
        // anything arrived would pass before the messages that could have
        // broken it were delivered — a test that cannot fail.
        await until(() => handled === 6, "all six messages");
        expect(partitions.size).toBe(1);
      });
    });

    describe("consumer groups", () => {
      spec("gives every message to every group", async () => {
        const topic = harness.topic("fanout");
        await broker.ensureTopics([{ topic, partitions: 1 }]);

        const left: string[] = [];
        const right: string[] = [];
        await subscribe("g-fanout-left", [topic], async (received) => {
          left.push(received.value.toString("utf8"));
        });
        await subscribe("g-fanout-right", [topic], async (received) => {
          right.push(received.value.toString("utf8"));
        });
        await broker.produce([message(topic, "k", "shared")]);

        await until(() => left.length === 1 && right.length === 1, "both groups");
        expect(left).toEqual(["shared"]);
        expect(right).toEqual(["shared"]);
      });

      spec(
        "splits partitions between members of one group, delivering each message once",
        async () => {
          const topic = harness.topic("split");
          await broker.ensureTopics([{ topic, partitions: 4 }]);

          const byMember: [string[], string[]] = [[], []];
          // Sequentially, not in parallel: two members joining at once is a
          // rebalance either way, but a real coordinator answers the second join
          // with the first member's assignment revoked, and racing them makes
          // which member ends up with which partition unpredictable in a way that
          // has nothing to do with what is being asserted.
          await subscribe("g-split", [topic], async (received) => {
            byMember[0].push(received.value.toString("utf8"));
          });
          await subscribe("g-split", [topic], async (received) => {
            byMember[1].push(received.value.toString("utf8"));
          });

          const keys = ["a", "b", "c", "d", "e", "f", "g", "h"];
          await broker.produce(keys.map((key) => message(topic, key, key)));

          await until(
            () => byMember[0].length + byMember[1].length === keys.length,
            "every message handled exactly once across the group",
          );
          expect([...byMember[0], ...byMember[1]].sort()).toEqual([...keys].sort());
        },
      );
    });

    describe("manual offset commits", () => {
      spec("redelivers a message whose handler rejected", async () => {
        const topic = harness.topic("redelivery");
        await broker.ensureTopics([{ topic, partitions: 1 }]);

        const attempts: string[] = [];
        await subscribe("g-redelivery", [topic], async (received) => {
          attempts.push(received.offset);
          // Fails once, then succeeds — which is what a transient failure looks
          // like, and what redelivery exists for.
          if (attempts.length === 1) throw new Error("handler said no");
        });
        await broker.produce([message(topic, "k", "retry-me")]);

        await until(() => attempts.length >= 2, "a second attempt");
        expect(attempts[0]).toBe(attempts[1]);
      });

      spec("does not commit past a message the handler rejected", async () => {
        const topic = harness.topic("no-skip");
        await broker.ensureTopics([{ topic, partitions: 1 }]);

        // Two messages on one partition, the first of which never succeeds. The
        // second must not be handled: committing past a failure is exactly the
        // silent message loss manual commits exist to prevent, and it is
        // head-of-line blocking that pays for it.
        const seen: string[] = [];
        await subscribe("g-no-skip", [topic], async (received) => {
          const body = received.value.toString("utf8");
          seen.push(body);
          if (body === "poison") throw new Error("always fails");
        });
        await broker.produce([message(topic, "k", "poison"), message(topic, "k", "after")]);

        await until(() => seen.length >= 3, "the poison message retried");
        expect(new Set(seen)).toEqual(new Set(["poison"]));
      });

      spec("treats a handler that never settles as failed, and redelivers", async () => {
        const topic = harness.topic("hung");
        await broker.ensureTopics([{ topic, partitions: 1 }]);

        // Found by running the application against a real cluster with one of
        // its dependencies down: the handler never settled, so the consumer sat
        // inside `eachMessage` and stopped heartbeating, and the coordinator
        // evicted the member. The service stopped consuming with nothing in its
        // log and a healthy `/health` — which is why a hung handler has to
        // become an ordinary failure rather than a silent exit from the group.
        let attempts = 0;
        await subscribe("g-hung", [topic], async () => {
          attempts += 1;
          if (attempts === 1) await new Promise(() => undefined);
        });
        await broker.produce([message(topic, "k", "hangs-once")]);

        await until(() => attempts >= 2, "the message to be redelivered past the hung attempt");
      });

      spec(
        "commits the offset after the message, so a later member does not re-read it",
        async () => {
          const topic = harness.topic("commit");
          await broker.ensureTopics([{ topic, partitions: 1 }]);

          const first: IncomingMessage[] = [];
          const subscription = await subscribe("g-commit", [topic], async (received) => {
            first.push(received);
          });
          await broker.produce([message(topic, "k", "once")]);
          await until(() => first.length === 1, "the first delivery");

          // Leaving and rejoining the same group is the observable form of "the
          // offset was committed": a new member reads from what the group
          // committed, so re-reading the message would mean the commit was
          // missing — and re-reading it *forever* would mean the commit was the
          // handled offset rather than the one after it.
          await subscription.stop();
          started = started.filter((candidate) => candidate !== subscription);

          const second: IncomingMessage[] = [];
          await subscribe("g-commit", [topic], async (received) => {
            second.push(received);
          });
          await broker.produce([message(topic, "k", "twice")]);

          await until(() => second.length === 1, "only the new message");
          expect(second[0]!.value.toString("utf8")).toBe("twice");
          expect(second[0]!.offset).toBe(nextOffset(first[0]!.offset));
        },
      );
    });
  });
}
