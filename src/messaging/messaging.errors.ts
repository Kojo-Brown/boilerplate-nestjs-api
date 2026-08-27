/**
 * A message on a domain-event topic that this build cannot turn into an event.
 *
 * Raised by the codec, never by the transport. The three ways to get here are a
 * missing or unrecognised `event-name` header, a `value` that is not JSON, and
 * a producer from another system writing to the topic — and all three are the
 * same problem from the consumer's side: bytes it has no way to interpret.
 *
 * Distinguished from a handler failure because the two want opposite
 * treatments. A handler failure is worth retrying: the database may come back.
 * An undecodable message is not — it will not become decodable by being read
 * again — so retrying it forever blocks its partition, which is why
 * `DomainEventConsumer` commits past one and logs it loudly instead. That is
 * the honest pre-dead-letter behaviour; `SPEC.md` Phase 10 item 2 is where such
 * a message gets somewhere to go.
 */
export class UndecodableMessageError extends Error {
  constructor(
    readonly topic: string,
    readonly partition: number,
    readonly offset: string,
    reason: string,
  ) {
    super(`Cannot decode ${topic}/${partition}@${offset}: ${reason}`);
    this.name = "UndecodableMessageError";
  }
}

/**
 * A subscription did not join its consumer group before the deadline.
 *
 * Joining is not instant — the coordinator has to receive the join request, run
 * an assignment round, and hand partitions out — and until it completes the
 * consumer is connected and reading nothing. Returning such a consumer to a
 * caller that produces immediately afterwards looks exactly like a lost
 * message, so `subscribe` waits for the join and fails loudly instead.
 *
 * A member that joins and is assigned *nothing* is not this error: a group with
 * more members than partitions is a legitimate, if wasteful, deployment, and the
 * idle members are the standby that picks up partitions when one dies.
 */
export class SubscriptionTimeoutError extends Error {
  constructor(groupId: string, timeoutMs: number) {
    super(
      `Consumer group "${groupId}" did not join within ${timeoutMs}ms. The brokers may be ` +
        `unreachable, or a rebalance may be in progress.`,
    );
    this.name = "SubscriptionTimeoutError";
  }
}

/**
 * A handler neither resolved nor rejected inside its bound.
 *
 * Found by running the application against a real cluster with one of its
 * dependencies down: `WelcomeEmailListener` enqueues through BullMQ, ioredis
 * retries a refused connection indefinitely, and the handler simply never
 * settled. Nothing failed — and that was the problem. A consumer sitting inside
 * `eachMessage` is not sending heartbeats, so after `KAFKA_SESSION_TIMEOUT_MS`
 * the coordinator evicted the member, the group went empty, and the service
 * stopped consuming with no error in its log and a healthy `/health`.
 *
 * The bound turns that into an ordinary handler failure: reported, not
 * committed, and redelivered. It does not *cancel* the handler — racing a
 * promise you did not create cannot — which is the same limit
 * `OutboxRelayService` documents for its publish timeout, and another reason
 * handlers have to be idempotent.
 */
export class HandlerTimeoutError extends Error {
  constructor(
    readonly topic: string,
    readonly partition: number,
    readonly offset: string,
    timeoutMs: number,
  ) {
    super(`Handler for ${topic}/${partition}@${offset} did not settle within ${timeoutMs}ms`);
    this.name = "HandlerTimeoutError";
  }
}

/** A broker method was called after `disconnect()`. */
export class BrokerClosedError extends Error {
  constructor(operation: string) {
    super(`MessageBroker is disconnected; "${operation}" is no longer available.`);
    this.name = "BrokerClosedError";
  }
}
