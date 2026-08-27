import { Logger } from "@nestjs/common";
import {
  Kafka,
  Partitioners,
  logLevel as KafkaLogLevel,
  type Admin,
  type Consumer,
  type EachMessagePayload,
  type KafkaConfig,
  type LogEntry,
  type Producer,
  type SASLOptions,
  type TopicMessages,
} from "kafkajs";
import type {
  IncomingMessage,
  MessageBroker,
  MessageBrokerName,
  OutgoingMessage,
  RunningSubscription,
  SubscriptionOptions,
  TopicSpec,
} from "./ports";
import { nextOffset } from "./ports";
import {
  BrokerClosedError,
  HandlerTimeoutError,
  SubscriptionTimeoutError,
} from "./messaging.errors";

export interface KafkaBrokerOptions {
  readonly clientId: string;
  readonly brokers: readonly string[];
  readonly ssl: boolean;
  readonly sasl?: SASLOptions;
  readonly connectionTimeoutMs: number;
  readonly requestTimeoutMs: number;
  /** Group session timeout. A member silent for this long is evicted and its partitions move. */
  readonly sessionTimeoutMs: number;
  readonly heartbeatIntervalMs: number;
  /**
   * How long a partition stays paused after a handler rejected a message.
   *
   * A floor on the redelivery interval, not the interval itself. The measured
   * gap on a real cluster is roughly `max(this, maxWaitTimeInMs)` — about five
   * seconds with KafkaJS's default fetch settings — because resuming a
   * partition does not produce a message: the next fetch does, and a fetch with
   * nothing new to report blocks at the broker until `maxWaitTimeInMs` elapses.
   * Setting this to 200ms therefore buys nothing over 1s. Driving it below a
   * second means lowering `maxWaitTimeInMs` too, which costs a fetch request per
   * partition per interval across the whole group, on every partition, whether
   * or not anything is failing.
   */
  readonly redeliveryDelayMs: number;
  /** How long `subscribe` waits for the group to be joined before failing. */
  readonly subscribeTimeoutMs: number;
  /**
   * How long one `handle` may take before it is treated as failed.
   *
   * A handler that never settles is worse than one that throws: the consumer
   * sits inside `eachMessage`, stops heartbeating, and is evicted from its group
   * after `sessionTimeoutMs` — so the service quietly stops consuming while
   * every other health signal stays green. See `HandlerTimeoutError`.
   */
  readonly handlerTimeoutMs: number;
}

/**
 * KafkaJS behind the `MessageBroker` port.
 *
 * Two decisions here are the whole item, and both are the kind that look like
 * configuration and behave like correctness:
 *
 * ### The producer acknowledges durably or not at all
 *
 * `idempotent: true`, which in KafkaJS forces `acks: -1` — every in-sync replica
 * must have the record before `send` resolves. Anything weaker makes
 * `OutboxPublisher.publish` resolve on a record that may not exist, the relay
 * marks the row `PUBLISHED`, and the event is gone: at-most-once delivery, out
 * of a mechanism whose entire purpose is to not have it. Idempotence also gives
 * the producer a sequence number per partition, so its *own* internal retry of a
 * send that was actually written does not append the record twice.
 *
 * ### Offsets are committed after the handler, never before
 *
 * `autoCommit: false`. KafkaJS's default commits on a timer while messages are
 * in flight, which means a process that dies mid-handler has already told the
 * broker it was done — the message is not redelivered and the work never
 * happened. Here the commit is the last thing that happens for a message, so
 * the failure mode is a message handled twice rather than a message lost.
 * Handlers must be idempotent; there is no third option.
 *
 * The commit is one round trip to the group coordinator per message. That is
 * the slow, safe end of the trade: committing every N messages or every T
 * milliseconds is the usual mitigation and widens the redelivery window to N
 * messages, which is a decision to make against a known throughput rather than
 * a default to ship.
 */
export class KafkaBroker implements MessageBroker {
  readonly name: MessageBrokerName = "kafka";

  private readonly logger = new Logger(KafkaBroker.name);
  private readonly kafka: Kafka;
  private readonly producer: Producer;
  private readonly subscriptions = new Set<RunningSubscription>();
  private admin: Admin | null = null;
  private connected = false;
  private closed = false;

  constructor(private readonly options: KafkaBrokerOptions) {
    const config: KafkaConfig = {
      clientId: options.clientId,
      brokers: [...options.brokers],
      ssl: options.ssl,
      connectionTimeout: options.connectionTimeoutMs,
      requestTimeout: options.requestTimeoutMs,
      // KafkaJS writes its own JSON to stdout otherwise, which means two log
      // formats in one process and a broker warning that no log aggregator
      // picks up next to the Nest lines it sits between.
      logCreator: () => (entry: LogEntry) => this.forward(entry),
    };
    if (options.sasl) config.sasl = options.sasl;

    this.kafka = new Kafka(config);
    this.producer = this.kafka.producer({
      idempotent: true,
      // Named explicitly, which is also what silences KafkaJS's startup warning
      // about it — and the warning is worth answering rather than muting. The
      // default partitioner matches the Java client's, so a key produced from
      // here lands on the partition a Java consumer, a Connect sink or
      // `kafka-console-producer` would put it on. `LegacyPartitioner` is
      // KafkaJS's pre-2.0 hash, kept only so an existing topic's keys do not
      // move partitions mid-upgrade; choosing it for a new topic would opt into
      // a partitioning nothing else in the ecosystem agrees with.
      createPartitioner: Partitioners.DefaultPartitioner,
    });
  }

  async connect(): Promise<void> {
    if (this.closed) throw new BrokerClosedError("connect");
    if (this.connected) return;
    await this.producer.connect();
    this.connected = true;
    this.logger.log(`Kafka producer connected to ${this.options.brokers.join(",")}`);
  }

  async ensureTopics(specs: readonly TopicSpec[]): Promise<void> {
    if (this.closed) throw new BrokerClosedError("ensureTopics");
    if (specs.length === 0) return;

    const admin = (this.admin ??= this.kafka.admin());
    await admin.connect();
    const existing = new Set(await admin.listTopics());
    const missing = specs.filter((spec) => !existing.has(spec.topic));

    if (missing.length > 0) {
      await admin.createTopics({
        topics: missing.map((spec) => ({ topic: spec.topic, numPartitions: spec.partitions })),
        // Without this `createTopics` returns before the metadata has
        // propagated, and a produce immediately afterwards fails with
        // `UNKNOWN_TOPIC_OR_PARTITION` on a topic that does exist.
        waitForLeaders: true,
      });
      this.logger.log(
        `Created topics: ${missing.map((s) => `${s.topic}(${s.partitions}p)`).join(", ")}`,
      );
    }

    // A topic that already exists is left exactly as it is, including its
    // partition count. Partitions cannot be removed, and adding them re-hashes
    // keys to different partitions — which silently breaks ordering for every
    // key that moves. Growing a topic is an operator's decision, taken knowing
    // that, not something a service does on boot because a number in its
    // environment changed.
    for (const spec of specs) {
      if (!existing.has(spec.topic)) continue;
      const [metadata] = (await admin.fetchTopicMetadata({ topics: [spec.topic] })).topics;
      if (metadata && metadata.partitions.length !== spec.partitions) {
        this.logger.warn(
          `Topic "${spec.topic}" has ${metadata.partitions.length} partitions, not the ` +
            `${spec.partitions} configured. Leaving it alone: adding partitions re-hashes ` +
            `keys and breaks per-key ordering.`,
        );
      }
    }
  }

  async produce(messages: readonly OutgoingMessage[]): Promise<void> {
    if (this.closed) throw new BrokerClosedError("produce");
    if (messages.length === 0) return;
    await this.connect();

    // `sendBatch` rather than a `send` per message: one request to each broker
    // for the whole batch instead of one per topic, and — the part that
    // matters — one acknowledgement to wait on rather than several in
    // sequence.
    const byTopic = new Map<string, TopicMessages>();
    for (const message of messages) {
      let entry = byTopic.get(message.topic);
      if (!entry) {
        entry = { topic: message.topic, messages: [] };
        byTopic.set(message.topic, entry);
      }
      entry.messages.push({
        key: message.key,
        value: message.value,
        headers: { ...message.headers },
      });
    }

    await this.producer.sendBatch({
      topicMessages: [...byTopic.values()],
      // Explicit, though `idempotent: true` already requires it. The one
      // setting on this call that decides whether the outbox is at-least-once
      // or at-most-once should not be inherited from a default.
      acks: -1,
    });
  }

  async subscribe(options: SubscriptionOptions): Promise<RunningSubscription> {
    if (this.closed) throw new BrokerClosedError("subscribe");

    const consumer = this.kafka.consumer({
      groupId: options.groupId,
      sessionTimeout: this.options.sessionTimeoutMs,
      heartbeatInterval: this.options.heartbeatIntervalMs,
      // A consumer that creates its own topics hides a misconfigured topic name
      // as an empty topic nobody ever produces to.
      allowAutoTopicCreation: false,
    });

    const joined = this.waitForGroupJoin(consumer, options.groupId);
    await consumer.connect();
    await consumer.subscribe({ topics: [...options.topics], fromBeginning: options.fromBeginning });
    await consumer.run({
      autoCommit: false,
      eachMessage: (payload) => this.handleMessage(consumer, options, payload),
    });
    // Returning before the group has been joined would hand back a consumer
    // that is connected and reading nothing, which reads as a lost message at
    // every call site that produces straight afterwards.
    await joined;

    const subscription: RunningSubscription = {
      groupId: options.groupId,
      stop: async () => {
        if (!this.subscriptions.delete(subscription)) return;
        // `stop` before `disconnect`: it waits for the batch in flight, so a
        // handler that has finished its work gets to commit rather than having
        // the message redelivered to whoever takes the partition next.
        await consumer.stop();
        await consumer.disconnect();
      },
    };
    this.subscriptions.add(subscription);
    return subscription;
  }

  async disconnect(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await Promise.all([...this.subscriptions].map((subscription) => subscription.stop()));
    if (this.connected) await this.producer.disconnect();
    if (this.admin) await this.admin.disconnect();
    this.connected = false;
  }

  /**
   * One message: hand it to the handler, then commit — in that order, always.
   *
   * A rejection takes the other branch and is where the manual-commit
   * bookkeeping actually lives:
   *
   * - **No commit.** The offset stays where it was, so the message is still
   *   owed.
   * - **`seek` back to it.** Without this the runner's in-memory read position
   *   has already moved past the message, and it would not be re-read until
   *   something forced a rebalance — so the message would be uncommitted *and*
   *   unhandled, which is the worst of both.
   * - **Pause the partition, and resume on a timer.** Otherwise the partition
   *   is re-fetched immediately and a handler failing on something that takes
   *   time to recover — a database, a downstream service — becomes a hot loop
   *   against it.
   *
   * The message is not thrown past this point. Throwing out of `eachMessage`
   * crashes the consumer, which rejoins the group and stalls every partition it
   * holds over a failure on one of them.
   *
   * What this cannot do without a dead-letter topic is give up. A message whose
   * handler always fails blocks its partition indefinitely — that is the honest
   * behaviour of at-least-once with manual commits and nowhere to put a poison
   * message, and `SPEC.md` Phase 10 item 2 is what changes it.
   */
  private async handleMessage(
    consumer: Consumer,
    options: SubscriptionOptions,
    { topic, partition, message, pause, heartbeat }: EachMessagePayload,
  ): Promise<void> {
    const incoming: IncomingMessage = {
      topic,
      partition,
      offset: message.offset,
      key: message.key === null ? null : message.key.toString("utf8"),
      value: message.value ?? Buffer.alloc(0),
      headers: decodeHeaders(message.headers),
      timestamp: new Date(Number(message.timestamp)),
    };

    try {
      await this.runHandler(options, incoming, heartbeat);
    } catch (caught: unknown) {
      const reason = caught instanceof Error ? caught.message : String(caught);
      this.logger.warn(
        `Handler for ${options.groupId} rejected ${topic}/${partition}@${message.offset}; ` +
          `not committing, retrying in ${this.options.redeliveryDelayMs}ms: ${reason}`,
      );
      consumer.seek({ topic, partition, offset: message.offset });
      const resume = pause();
      setTimeout(resume, this.options.redeliveryDelayMs).unref();
      return;
    }

    await consumer.commitOffsets([
      // `nextOffset`, not `message.offset`. A committed offset is the next
      // message to read; committing the one just handled replays it forever.
      { topic, partition, offset: nextOffset(message.offset) },
    ]);
  }

  /**
   * Runs one handler under a heartbeat and a bound.
   *
   * The heartbeat is the half that keeps a *slow* handler in its group. KafkaJS
   * heartbeats between messages, not during one, so work that outlives the
   * session timeout would otherwise trigger a rebalance and have its message
   * handed to another member — a redelivery storm rather than progress.
   *
   * The bound is the half that keeps a *stuck* handler visible, and the two have
   * to travel together: heartbeating alone would keep a permanently hung handler
   * in the group forever, holding its partitions and reading nothing, which is
   * the same outage with a better disguise.
   *
   * A heartbeat can reject with `REBALANCE_IN_PROGRESS`, which is KafkaJS's
   * signal to its own runner rather than a fault of this handler. Swallowed
   * here: the runner acts on it through its own path, and an unhandled rejection
   * raised from a timer would take the process down.
   */
  private async runHandler(
    options: SubscriptionOptions,
    incoming: IncomingMessage,
    heartbeat: () => Promise<void>,
  ): Promise<void> {
    const ticker = setInterval(() => {
      void heartbeat().catch(() => undefined);
    }, this.options.heartbeatIntervalMs);
    ticker.unref();

    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        options.handle(incoming),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new HandlerTimeoutError(
                  incoming.topic,
                  incoming.partition,
                  incoming.offset,
                  this.options.handlerTimeoutMs,
                ),
              ),
            this.options.handlerTimeoutMs,
          );
        }),
      ]);
    } finally {
      clearInterval(ticker);
      if (timer) clearTimeout(timer);
    }
  }

  /** Resolves on the group's first `GROUP_JOIN`, rejects if it does not arrive. */
  private waitForGroupJoin(consumer: Consumer, groupId: string): Promise<void> {
    const timeoutMs = this.options.subscribeTimeoutMs;
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        remove();
        reject(new SubscriptionTimeoutError(groupId, timeoutMs));
      }, timeoutMs);
      const remove = consumer.on(consumer.events.GROUP_JOIN, () => {
        clearTimeout(timer);
        remove();
        resolve();
      });
    });
  }

  /** KafkaJS's own log lines, at the Nest level that matches. */
  private forward(entry: LogEntry): void {
    const text = `${entry.namespace}: ${entry.log.message}`;
    switch (entry.level) {
      case KafkaLogLevel.ERROR:
      case KafkaLogLevel.NOTHING:
        this.logger.error(text);
        break;
      case KafkaLogLevel.WARN:
        this.logger.warn(text);
        break;
      case KafkaLogLevel.DEBUG:
        this.logger.debug(text);
        break;
      default:
        this.logger.log(text);
    }
  }
}

/**
 * Kafka headers are `bytes -> bytes`, and KafkaJS surfaces them as
 * `Buffer | string | (Buffer | string)[] | undefined` — the array case being a
 * header sent more than once, which is legal on the wire. The port narrows all
 * of that to UTF-8 strings; a repeated header keeps its first value, matching
 * how every HTTP client this repository talks to treats the same situation.
 */
function decodeHeaders(headers: EachMessagePayload["message"]["headers"]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers ?? {})) {
    if (value === undefined) continue;
    const first = Array.isArray(value) ? value[0] : value;
    if (first === undefined) continue;
    out[key] = typeof first === "string" ? first : first.toString("utf8");
  }
  return out;
}
