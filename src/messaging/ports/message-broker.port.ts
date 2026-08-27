/**
 * Which implementation backs `MessageBroker`.
 *
 * `kafka` is a real cluster over KafkaJS. `memory` is an in-process broker that
 * models the parts of Kafka this port exposes — partitions, consumer groups,
 * per-group committed offsets, and redelivery from the last commit — so the
 * behavioural contract can be asserted without a cluster. It is a test double
 * that happens to be a working broker, not a no-op: it is refused in production
 * below the moment anything real depends on it.
 *
 * Declared here rather than in `config/env.schema.ts` so the module owns its own
 * vocabulary, matching `WORKER_POOL_NAMES`, `DISTRIBUTED_LOCK_NAMES`,
 * `IDEMPOTENCY_STORE_NAMES` and `STORAGE_ADAPTER_NAMES`.
 */
export const MESSAGE_BROKER_NAMES = ["kafka", "memory"] as const;

export type MessageBrokerName = (typeof MESSAGE_BROKER_NAMES)[number];

/** Injection token for the selected {@link MessageBroker}. */
export const MESSAGE_BROKER = Symbol("MESSAGE_BROKER");

/**
 * A message on its way to a topic.
 *
 * `key` is the partition key, and it is the only ordering control Kafka offers:
 * messages sharing a key land on the same partition and are read in the order
 * they were written, while messages on different partitions have no order at
 * all. A `null` key round-robins, which means giving up ordering — deliberate
 * for a message nothing else is ordered against, and a bug for anything else.
 *
 * `value` is bytes rather than an object because that is what the wire carries.
 * Encoding is the caller's decision (`domain-event-codec.ts` makes it for domain
 * events) and stays out of the transport.
 */
export interface OutgoingMessage {
  readonly topic: string;
  readonly key: string | null;
  readonly value: Buffer;
  /**
   * Kafka headers are `bytes -> bytes`; restricting them to UTF-8 strings here
   * keeps metadata readable in `kafka-console-consumer` and in the in-memory
   * double alike. Anything that is not text belongs in `value`.
   */
  readonly headers: Readonly<Record<string, string>>;
}

/** A message a subscriber has been handed. */
export interface IncomingMessage {
  readonly topic: string;
  readonly partition: number;
  /**
   * A string, never a number. Kafka offsets are signed 64-bit and a partition
   * that has carried more than 2^53 messages — an entirely ordinary number for
   * a busy topic left running for a year — cannot round-trip through a
   * JavaScript `number`. Arithmetic on it goes through `BigInt`; see
   * `nextOffset()`.
   */
  readonly offset: string;
  readonly key: string | null;
  readonly value: Buffer;
  readonly headers: Readonly<Record<string, string>>;
  /** The broker's record timestamp, not when this process received it. */
  readonly timestamp: Date;
}

/** A topic and the partition count it should exist with. */
export interface TopicSpec {
  readonly topic: string;
  /**
   * Partitions are the unit of consumer parallelism: a group can usefully run
   * at most one consumer per partition, and members past that idle. The count
   * can be raised later but never lowered, and raising it re-hashes keys to
   * different partitions, which breaks ordering for keys that move — so it is a
   * capacity decision made once, not a knob.
   */
  readonly partitions: number;
}

/**
 * What a caller asks for when it wants to read a topic.
 *
 * ### Consumer groups
 *
 * `groupId` names a *logical* subscriber, not a process. Every partition of
 * every subscribed topic is assigned to exactly one member of the group, so
 * running three replicas of the same service means the three of them split the
 * partitions and each message is handled once — that is horizontal scale.
 * Running two *different* `groupId`s over the same topic means both get every
 * message — that is fan-out. Getting these two backwards is the classic Kafka
 * mistake, and it is why `groupId` is a required field rather than something
 * with a default.
 *
 * ### Commits
 *
 * There is no `commit()` on this interface, and that is the design. `handle`
 * resolving *is* the commit: the adapter commits the offset after the handler
 * returns and not before, so a caller cannot commit early by accident and
 * cannot forget to commit at all. `handle` rejecting leaves the offset
 * uncommitted and the message is redelivered.
 *
 * The consequence is at-least-once delivery, unconditionally: a process that
 * dies between a successful `handle` and its commit will see that message
 * again. Handlers have to be idempotent. Nothing here can change that — the
 * alternative is committing before handling, which is at-most-once and loses
 * messages instead.
 */
export interface SubscriptionOptions {
  readonly groupId: string;
  readonly topics: readonly string[];
  /**
   * Where a group with no committed offset starts. `true` reads the topic from
   * its retained beginning, `false` reads only what arrives after the group
   * first connects. Irrelevant once the group has committed anything.
   */
  readonly fromBeginning: boolean;
  handle(message: IncomingMessage): Promise<void>;
}

/** A subscription that is running. */
export interface RunningSubscription {
  readonly groupId: string;
  /**
   * Leaves the group and stops delivering. Waits for a handler in flight, so a
   * message being processed at shutdown is committed rather than redelivered to
   * whoever takes the partition next.
   */
  stop(): Promise<void>;
}

/**
 * The transport seam: publish bytes to a topic, read bytes from a topic.
 *
 * Deliberately thinner than KafkaJS. It carries the two things this repository
 * actually depends on — partition keys, and commit-after-handle — and nothing
 * else, so the in-memory double can be a faithful implementation rather than an
 * approximation with holes. Transactions, exactly-once semantics, compaction
 * and admin operations beyond topic creation are not modelled, and a caller
 * that needs them should take `KafkaBroker` directly and say why.
 */
export interface MessageBroker {
  readonly name: MessageBrokerName;

  /**
   * Connects the producer. Called at bootstrap so a broker that is unreachable
   * fails the deployment rather than the first publish.
   */
  connect(): Promise<void>;

  /**
   * Creates any of `specs` that do not exist, and leaves the ones that do
   * alone — including when their partition count differs, since lowering it is
   * impossible and raising it silently would re-hash keys.
   */
  ensureTopics(specs: readonly TopicSpec[]): Promise<void>;

  /**
   * Publishes, resolving only once the brokers have durably acknowledged.
   *
   * "Durably" is the whole contract. `OutboxPublisher` marks a row `PUBLISHED`
   * when its `publish` resolves, so an implementation that resolved on enqueue
   * would turn the outbox back into at-most-once delivery — the exact failure
   * it exists to remove.
   */
  produce(messages: readonly OutgoingMessage[]): Promise<void>;

  subscribe(options: SubscriptionOptions): Promise<RunningSubscription>;

  /** Idempotent. Stops every subscription this broker started, then disconnects. */
  disconnect(): Promise<void>;
}

/**
 * The offset to commit after processing `offset`.
 *
 * A committed offset in Kafka is *the next message to read*, not the last one
 * read. Committing `message.offset` therefore replays that message on every
 * restart, forever — the single most common bug in hand-rolled manual-commit
 * code, and one that only shows up after a rebalance or a redeploy, which is
 * why it lives in a named function with a test rather than inline at the call
 * site.
 *
 * `BigInt`, because these are int64 values (see {@link IncomingMessage.offset}).
 */
export function nextOffset(offset: string): string {
  return (BigInt(offset) + 1n).toString();
}
