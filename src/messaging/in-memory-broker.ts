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
import { BrokerClosedError, HandlerTimeoutError } from "./messaging.errors";

/** One record as it sits in a partition log. */
interface StoredRecord {
  readonly key: string | null;
  readonly value: Buffer;
  readonly headers: Readonly<Record<string, string>>;
  readonly timestamp: Date;
}

/** A consumer group's view of the world: who is in it, and how far it has read. */
interface Group {
  /** `topic#partition` -> the next offset to read. Kafka's committed-offset semantics. */
  readonly committed: Map<string, bigint>;
  /** In join order, which is what the assignment is computed from. */
  members: Member[];
}

interface Member {
  readonly options: SubscriptionOptions;
  assigned: readonly string[];
  /**
   * The next offset this member will *read* from each partition it holds.
   *
   * Distinct from the group's committed offsets, and the distinction is
   * Kafka's own: the position is where the reader is, the committed offset is
   * what has been durably recorded, and they differ for exactly as long as a
   * message is in flight. Modelling only the committed offset makes
   * `fromBeginning: false` unimplementable — the start position would be
   * re-derived from the log's current end on every pass, so a member would
   * skip past each message as it arrived and never read anything at all.
   *
   * Resolved once per partition, from the group's committed offset if it has
   * one and from `fromBeginning` if it does not, and dropped when the partition
   * is reassigned so the next holder resolves it against the commit rather than
   * inheriting a stale read position.
   */
  readonly positions: Map<string, bigint>;
  stopped: boolean;
  /** The pump in flight, so `stop()` can wait for a handler rather than cut it off. */
  pump: Promise<void>;
  /** Resolves the pump's idle wait when something is produced or the assignment changes. */
  wake: (() => void) | null;
  /**
   * A wake that arrived while the member was not waiting.
   *
   * Without it a produce that lands between the end of a read pass and the
   * `await` inside `idle()` is lost, and the member sleeps on a partition that
   * already has a message in it until something else happens to wake it — a
   * hang that only appears under timing a test rarely reproduces on purpose.
   */
  pending: boolean;
}

export interface InMemoryBrokerOptions {
  /**
   * Partitions given to a topic created implicitly by `produce`. Mirrors a real
   * broker's `num.partitions` and its default of 1 — which is why a topic that
   * needs parallelism has to be declared through `ensureTopics` rather than
   * left to appear on first write.
   */
  readonly defaultPartitions?: number;
  /**
   * How long a member waits before re-reading a message its handler rejected.
   *
   * A real consumer's redelivery interval is a function of KafkaJS's retry
   * backoff and the fetch loop; here it is a number, small enough that a test
   * asserting redelivery does not sleep and large enough that a permanently
   * failing handler does not spin a core.
   */
  readonly redeliveryDelayMs?: number;
  /**
   * How long one `handle` may take before it is treated as failed. Modelled
   * here as well as in `KafkaBroker` because it is a property of the port, not
   * of a client library: a handler that never settles must not be able to stall
   * a partition invisibly, whichever backend is running.
   */
  readonly handlerTimeoutMs?: number;
}

/**
 * An in-process broker that behaves like the parts of Kafka this port exposes.
 *
 * It is a real implementation of `MessageBroker`, not a stub: partitions are
 * append-only logs, keys hash to a partition, consumer groups keep their own
 * committed offsets, members of one group split the partitions between them,
 * and a handler that rejects leaves its offset uncommitted so the message comes
 * back. Those are the five properties `message-broker.contract.ts` asserts, and
 * they hold here for the same reason they hold on a cluster rather than because
 * the test was written around a `Map`.
 *
 * What it deliberately does not model: durability (the logs are gone with the
 * process), replication, retention or compaction, transactions, and the timing
 * of a real rebalance. It is the right broker for the unit suite, the e2e suite,
 * and a single-process development run — and it is refused in production by
 * `env.schema.ts` the moment `OUTBOX_PUBLISHER=broker` depends on it, because a
 * broker inside the process reaches no other replica, which is the entire reason
 * to have one.
 */
export class InMemoryBroker implements MessageBroker {
  readonly name: MessageBrokerName = "memory";

  private readonly partitions = new Map<string, StoredRecord[][]>();
  private readonly groups = new Map<string, Group>();
  private readonly defaultPartitions: number;
  private readonly redeliveryDelayMs: number;
  private readonly handlerTimeoutMs: number;
  private closed = false;

  constructor(options: InMemoryBrokerOptions = {}) {
    this.defaultPartitions = options.defaultPartitions ?? 1;
    this.redeliveryDelayMs = options.redeliveryDelayMs ?? 5;
    this.handlerTimeoutMs = options.handlerTimeoutMs ?? 30_000;
  }

  async connect(): Promise<void> {
    if (this.closed) throw new BrokerClosedError("connect");
  }

  async ensureTopics(specs: readonly TopicSpec[]): Promise<void> {
    if (this.closed) throw new BrokerClosedError("ensureTopics");
    for (const spec of specs) {
      // Existing topics are left alone, including when the count differs —
      // the same thing `KafkaBroker` does, and for the same reason: partitions
      // cannot be removed, and adding them re-hashes keys.
      if (!this.partitions.has(spec.topic)) {
        this.partitions.set(
          spec.topic,
          Array.from({ length: spec.partitions }, (): StoredRecord[] => []),
        );
      }
    }
  }

  async produce(messages: readonly OutgoingMessage[]): Promise<void> {
    if (this.closed) throw new BrokerClosedError("produce");

    const touched = new Set<string>();
    for (const message of messages) {
      const logs = this.logsFor(message.topic);
      const partition = partitionFor(message.key, logs.length);
      // In range by construction — `partitionFor` returns `hash % logs.length` —
      // but `noUncheckedIndexedAccess` types the read as possibly undefined, and
      // `??=` is the form that satisfies it without discarding a record.
      const log = (logs[partition] ??= []);
      log.push({
        key: message.key,
        value: message.value,
        headers: { ...message.headers },
        timestamp: new Date(),
      });
      touched.add(message.topic);
    }

    // Resolving here is what makes this a *durable* acknowledgement in the same
    // sense the port requires: the record is in the log and will be read. It is
    // deliberately not "and every subscriber has handled it" — a broker that
    // waited for consumers would not be a broker.
    for (const topic of touched) this.wakeSubscribersOf(topic);
  }

  async subscribe(options: SubscriptionOptions): Promise<RunningSubscription> {
    if (this.closed) throw new BrokerClosedError("subscribe");

    const group = this.groupFor(options.groupId);
    const member: Member = {
      options,
      assigned: [],
      positions: new Map(),
      stopped: false,
      pump: Promise.resolve(),
      wake: null,
      pending: false,
    };
    group.members.push(member);
    this.rebalance(options.groupId);
    member.pump = this.run(options.groupId, member);

    return {
      groupId: options.groupId,
      stop: async () => {
        if (member.stopped) return;
        member.stopped = true;
        notify(member);
        await member.pump;
        group.members = group.members.filter((candidate) => candidate !== member);
        // Leaving triggers a rebalance in a real group too: the partitions this
        // member held have to go somewhere, and a test that asserts the
        // survivor picks them up depends on it happening here.
        this.rebalance(options.groupId);
      },
    };
  }

  async disconnect(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const members = [...this.groups.values()].flatMap((group) => group.members);
    for (const member of members) {
      member.stopped = true;
      notify(member);
    }
    await Promise.all(members.map((member) => member.pump));
    for (const group of this.groups.values()) group.members = [];
  }

  /** Committed offsets per `topic#partition`, for assertions. Not part of the port. */
  committedOffsets(groupId: string): ReadonlyMap<string, string> {
    const group = this.groups.get(groupId);
    const out = new Map<string, string>();
    for (const [key, offset] of group?.committed ?? []) out.set(key, offset.toString());
    return out;
  }

  private logsFor(topic: string): StoredRecord[][] {
    let logs = this.partitions.get(topic);
    if (!logs) {
      logs = Array.from({ length: this.defaultPartitions }, (): StoredRecord[] => []);
      this.partitions.set(topic, logs);
    }
    return logs;
  }

  private groupFor(groupId: string): Group {
    let group = this.groups.get(groupId);
    if (!group) {
      group = { committed: new Map(), members: [] };
      this.groups.set(groupId, group);
    }
    return group;
  }

  /**
   * Hands every partition of every subscribed topic to exactly one member.
   *
   * Round-robin over the partitions in a stable order, which is the property
   * that matters rather than the particular strategy: no partition is
   * unassigned, no partition is assigned twice, and members past the partition
   * count get nothing — the reason a group cannot be scaled beyond a topic's
   * partitions no matter how many replicas are running.
   */
  private rebalance(groupId: string): void {
    const group = this.groupFor(groupId);
    if (group.members.length === 0) return;

    const topics = [...new Set(group.members.flatMap((member) => member.options.topics))].sort();
    const keys: string[] = [];
    for (const topic of topics) {
      const logs = this.logsFor(topic);
      for (let partition = 0; partition < logs.length; partition += 1) {
        keys.push(partitionKey(topic, partition));
      }
    }

    const assignments: string[][] = group.members.map(() => []);
    keys.forEach((key, index) => {
      (assignments[index % group.members.length] ??= []).push(key);
    });
    group.members.forEach((member, index) => {
      member.assigned = assignments[index] ?? [];
      // A partition this member no longer holds takes its read position with
      // it. Keeping it would mean that on getting the partition back the member
      // resumed from where *it* had read to, rather than from what the group
      // committed — silently re-handling or skipping whatever the other member
      // did in between.
      const held = new Set(member.assigned);
      for (const key of member.positions.keys()) {
        if (!held.has(key)) member.positions.delete(key);
      }
      notify(member);
    });
  }

  private wakeSubscribersOf(topic: string): void {
    for (const group of this.groups.values()) {
      for (const member of group.members) {
        if (member.options.topics.includes(topic)) notify(member);
      }
    }
  }

  /**
   * One member's read loop.
   *
   * Serial over its assigned partitions, and serial within each: that is what
   * makes ordering within a partition observable, and it is why a slow handler
   * on one partition delays the others this member owns — true of a real
   * `eachMessage` consumer too, and the reason partition count is a capacity
   * decision.
   */
  private async run(groupId: string, member: Member): Promise<void> {
    const group = this.groupFor(groupId);

    while (!member.stopped) {
      let delivered = false;
      let failed = false;

      for (const key of member.assigned) {
        if (member.stopped) break;
        const { topic, partition } = parsePartitionKey(key);
        const log = this.logsFor(topic)[partition];
        if (log === undefined) continue;

        let from = member.positions.get(key);
        if (from === undefined) {
          from = group.committed.get(key) ?? this.startOffset(member, log);
          member.positions.set(key, from);
        }
        if (from >= BigInt(log.length)) continue;

        const record = log[Number(from)];
        if (record === undefined) continue;
        const message: IncomingMessage = {
          topic,
          partition,
          offset: from.toString(),
          key: record.key,
          value: record.value,
          headers: record.headers,
          timestamp: record.timestamp,
        };

        try {
          await this.callHandler(member, message);
        } catch {
          // Not committed, so this exact offset is read again on the next pass.
          // The rejection is swallowed rather than propagated because there is
          // nobody to propagate it to: the caller of `subscribe` is long gone,
          // and a real consumer's failure surfaces as redelivery, which is
          // exactly what happens here.
          failed = true;
          continue;
        }
        const next = BigInt(nextOffset(message.offset));
        // Committed *and* advanced, in that order and only after `handle`
        // resolved. This is the whole of "manual offset commits" in the double.
        group.committed.set(key, next);
        member.positions.set(key, next);
        delivered = true;
      }

      if (member.stopped) break;
      if (delivered) continue;
      await this.idle(member, failed ? this.redeliveryDelayMs : null);
    }
  }

  /**
   * Where a member starts when its group has never committed this partition.
   *
   * `fromBeginning` reads the retained log; otherwise the member starts at the
   * end and sees only what arrives next. Evaluated once, when the partition's
   * position is first resolved — which is what a real consumer does on
   * assignment, and is why the answer is cached in `positions` rather than
   * recomputed.
   */
  private startOffset(member: Member, log: readonly StoredRecord[]): bigint {
    return member.options.fromBeginning ? 0n : BigInt(log.length);
  }

  /**
   * One handler call, bounded.
   *
   * The bound does not cancel the handler — racing a promise you did not create
   * cannot — so a hung handler goes on hanging; what it stops is the partition
   * hanging silently with it. Same limit, and same reason, as the timeout in
   * `KafkaBroker.runHandler` and the one in `OutboxRelayService.deliver`.
   */
  private async callHandler(member: Member, message: IncomingMessage): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        member.options.handle(message),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new HandlerTimeoutError(
                  message.topic,
                  message.partition,
                  message.offset,
                  this.handlerTimeoutMs,
                ),
              ),
            this.handlerTimeoutMs,
          );
          timer.unref();
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** Waits for a produce, a rebalance, a stop, or — after a failure — a retry. */
  private async idle(member: Member, retryAfterMs: number | null): Promise<void> {
    // A wake that arrived during the read pass is consumed here rather than
    // slept through. See `Member.pending`.
    if (member.pending || member.stopped) {
      member.pending = false;
      return;
    }
    await new Promise<void>((resolve) => {
      let timer: NodeJS.Timeout | undefined;
      const done = (): void => {
        if (timer) clearTimeout(timer);
        member.wake = null;
        member.pending = false;
        resolve();
      };
      member.wake = done;
      if (retryAfterMs !== null) {
        timer = setTimeout(done, retryAfterMs);
        // The double must never be the reason a test process stays alive.
        timer.unref();
      }
    });
  }
}

/**
 * Wakes a member, or records that it should not go to sleep.
 *
 * The second half is the part that matters: `wake` is only set while the member
 * is actually waiting, so a notification outside that window has to be
 * remembered rather than dropped.
 */
function notify(member: Member): void {
  member.pending = true;
  member.wake?.();
}

function partitionKey(topic: string, partition: number): string {
  return `${topic}#${partition}`;
}

function parsePartitionKey(key: string): { topic: string; partition: number } {
  const separator = key.lastIndexOf("#");
  return { topic: key.slice(0, separator), partition: Number(key.slice(separator + 1)) };
}

/**
 * Which partition a key lands on.
 *
 * FNV-1a rather than Kafka's murmur2, and the difference does not matter: the
 * contract asserts that one key always lands on one partition, never *which*
 * one. Matching murmur2 exactly would only matter to a test that produced
 * through this double and consumed from a real cluster, which nothing does.
 *
 * A `null` key round-robins on a real producer. Here it is spread by a counter
 * for the same effect — order between null-keyed messages is not preserved
 * across partitions either way, which is the property that matters.
 */
let roundRobin = 0;
function partitionFor(key: string | null, partitions: number): number {
  if (key === null) {
    roundRobin = (roundRobin + 1) % Number.MAX_SAFE_INTEGER;
    return roundRobin % partitions;
  }
  let hash = 0x811c9dc5;
  for (let index = 0; index < key.length; index += 1) {
    hash ^= key.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash % partitions;
}
