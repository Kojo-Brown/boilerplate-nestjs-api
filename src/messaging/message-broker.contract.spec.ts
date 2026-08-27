import { randomUUID } from "crypto";
import { describeMessageBrokerContract } from "./message-broker.contract";
import { InMemoryBroker } from "./in-memory-broker";
import { KafkaBroker } from "./kafka-broker.service";

/**
 * One contract, both backends.
 *
 * The Kafka leg runs against a real cluster whenever `KAFKA_BROKERS` names one,
 * which CI always does — the `test` job has a single-node KRaft broker as a
 * service. That is not decoration. Three of the properties this contract
 * asserts are properties of *Kafka*, not of the code in front of it: that a
 * committed offset is the next one to read, that a group's members are assigned
 * disjoint partitions, and that a rejoining member resumes from what was
 * committed. Asserted only against the double they would be properties of a
 * `Map`; asserted only against a cluster, nothing would stop the double the
 * unit and e2e suites run the whole application on from breaking all three.
 *
 * An environment without a broker reports the leg pending rather than skipping
 * it green, matching `worker-pool.contract.spec.ts`.
 */

describeMessageBrokerContract(
  "InMemoryBroker",
  async () => {
    const handlerTimeoutMs = 200;
    const broker = new InMemoryBroker({
      defaultPartitions: 1,
      redeliveryDelayMs: 5,
      handlerTimeoutMs,
    });
    const run = randomUUID().slice(0, 8);
    return {
      broker,
      deadlineMs: 2_000,
      handlerTimeoutMs,
      topic: (suffix) => `mem-${run}-${suffix}`,
    };
  },
  async (harness) => {
    await harness.broker.disconnect();
  },
  10_000,
);

const brokers = (process.env.KAFKA_BROKERS ?? "")
  .split(",")
  .map((entry) => entry.trim())
  .filter(Boolean);

if (brokers.length > 0) {
  describeMessageBrokerContract(
    "KafkaBroker",
    async () => {
      const broker = new KafkaBroker({
        clientId: "contract-spec",
        brokers,
        ssl: false,
        connectionTimeoutMs: 10_000,
        requestTimeoutMs: 30_000,
        // Short, so a member that stops without leaving cleanly does not hold
        // its partitions for the default 30s and stall the next spec's group.
        // Floored by the broker's `group.min.session.timeout.ms`, 6s by default.
        sessionTimeoutMs: 6_000,
        heartbeatIntervalMs: 1_000,
        redeliveryDelayMs: 200,
        subscribeTimeoutMs: 30_000,
        // Short, so the hung-handler leg finishes inside the deadline. The
        // production default is a minute; what the contract asserts is that the
        // bound exists and turns a hang into a redelivery, not its value.
        handlerTimeoutMs: 2_000,
      });
      const run = randomUUID().slice(0, 8);
      return {
        broker,
        // A rebalance, a fetch cycle and a commit round trip, with room for a
        // loaded CI runner. Generous on purpose: every assertion polls to this
        // deadline and returns as soon as it is satisfied, so a large number
        // costs nothing when things are working and is the difference between
        // a flake and a failure when they are not.
        deadlineMs: 30_000,
        handlerTimeoutMs: 2_000,
        topic: (suffix) => `contract-${run}-${suffix}`,
      };
    },
    async (harness) => {
      await harness.broker.disconnect();
    },
    // Comfortably past the 30s harness deadline, so a spec that times out
    // reports the thing it was waiting for rather than a bare Jest timeout.
    60_000,
  );
} else {
  describe("KafkaBroker (message broker contract)", () => {
    it.todo("set KAFKA_BROKERS to run this contract against a real cluster");
  });
}
