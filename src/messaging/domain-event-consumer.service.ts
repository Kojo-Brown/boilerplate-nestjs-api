import { Inject, Injectable, Logger, Optional } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { BackoffPolicy } from "@/common/backoff";
import type { Env } from "@/config/env.schema";
import { DomainEventBus } from "@/events";
import { EventContract } from "@/schema-registry";
import { MESSAGE_BROKER, type IncomingMessage, type MessageBroker } from "./ports";
import { DEAD_LETTER_JITTER, DOMAIN_EVENTS_TOPIC } from "./messaging.tokens";
import { decodeDomainEvent } from "./domain-event-codec";
import { SchemaContractViolationError, UndecodableMessageError } from "./messaging.errors";
import { DeadLetterQueue } from "./dead-letter-queue.service";
import { runRetryLadder } from "./retry-ladder";
import type { DeadLetterReason } from "./dead-letter";
import type { DecodedDomainEvent } from "./domain-event-codec";

/**
 * The consumer half of Phase 10: reads the domain-event topic and puts what it
 * finds on this process's `DomainEventBus`.
 *
 * That is the whole job, and the modesty is the point. Subscribers keep being
 * `@OnDomainEvent` methods on ordinary providers, discovered by the same loader,
 * with the same signatures — a listener written before there was a broker does
 * not know there is one now. What changed is upstream of it: the event no longer
 * has to have been published by *this* process to arrive.
 *
 * ### Why the group id is the whole deployment, not the process
 *
 * `KAFKA_CONSUMER_GROUP_ID` defaults to the service name, and every replica of
 * the service uses it. The group's members split the partitions, so one replica
 * handles each event and a welcome email is sent once no matter how many
 * replicas are running. Giving each replica its own group id — an easy accident
 * when the value is derived from a hostname or a pod name — turns the same
 * deployment into fan-out and sends the email once per replica.
 *
 * A *different* service reading the same topic uses a *different* group id, and
 * gets its own copy of the stream. That is the fan-out `DomainEventBusPublisher`
 * could never provide, and the reason this file exists.
 *
 * ### What a failure does
 *
 * `publishAndSettle` reports every subscriber's outcome, and one failure fails
 * the attempt. An attempt that fails is retried in place, on a full-jitter
 * exponential ladder, up to `KAFKA_RETRY_MAX_ATTEMPTS`; every retry re-runs the
 * *whole* event, successful subscribers included, which is the same at-least-once
 * bargain the outbox relay makes with the same bus and is why `@OnDomainEvent`
 * handlers have to be idempotent.
 *
 * A ladder that runs out sends the message to the dead-letter topic and commits
 * past it. That is the one behaviour this class exists to add, and it is what
 * stops a message nothing can handle from holding its partition — and every
 * well-formed event behind it — forever. Before it, "give up" was not something
 * this consumer could do; the choice was between blocking the partition and
 * dropping the message, and it took the first for handler failures and the
 * second for undecodable ones.
 *
 * ### The two ways to reach the dead-letter topic
 *
 * An **undecodable** message skips the ladder entirely and goes straight there.
 * Retrying it cannot help: bytes that are not a domain event this build
 * recognises will not become one by being read again, so the ladder would spend
 * its whole budget proving what the first `decodeDomainEvent` already proved.
 *
 * A **handler failure** gets the ladder, because the opposite is true of it: a
 * database that is down, a queue that is refusing connections, a downstream
 * service mid-deploy are all conditions that pass, and most of them pass inside
 * a couple of seconds.
 */
@Injectable()
export class DomainEventConsumer {
  private readonly logger = new Logger(DomainEventConsumer.name);

  private readonly enabled: boolean;
  private readonly groupId: string;
  private readonly policy: BackoffPolicy;
  private subscription: { stop(): Promise<void> } | null = null;
  /**
   * Aborted before the subscription is stopped, so a ladder mid-sleep unwinds
   * instead of being waited out. Recreated on every `start()` so a consumer that
   * is stopped and started again — which the e2e suite does — is not born
   * already aborted.
   */
  private shutdown = new AbortController();

  constructor(
    @Inject(MESSAGE_BROKER) private readonly broker: MessageBroker,
    @Inject(DOMAIN_EVENTS_TOPIC) private readonly topic: string,
    private readonly bus: DomainEventBus,
    private readonly deadLetters: DeadLetterQueue,
    private readonly contract: EventContract,
    config: ConfigService<Env, true>,
    @Optional() @Inject(DEAD_LETTER_JITTER) private readonly random: () => number = Math.random,
  ) {
    this.enabled = config.get("KAFKA_CONSUMER_ENABLED", { infer: true });
    this.groupId = config.get("KAFKA_CONSUMER_GROUP_ID", { infer: true });
    this.policy = {
      maxAttempts: config.get("KAFKA_RETRY_MAX_ATTEMPTS", { infer: true }),
      baseMs: config.get("KAFKA_RETRY_BASE_MS", { infer: true }),
      maxMs: config.get("KAFKA_RETRY_MAX_DELAY_MS", { infer: true }),
    };
  }

  /**
   * Joins the group and starts reading.
   *
   * Called by `MessagingLifecycle` rather than by a lifecycle hook of its own,
   * and that is not a style preference: the broker has to be connected and the
   * topic has to exist first, and Nest gives no ordering guarantee between two
   * providers' `onApplicationBootstrap` hooks in the same module. Subscribing
   * first would mean joining a group on a topic that does not exist yet — which
   * `allowAutoTopicCreation: false` makes a consumer that reads nothing until a
   * metadata refresh happens to notice the topic appear.
   */
  async start(): Promise<void> {
    if (!this.enabled) {
      this.logger.log(
        "Domain event consumer is disabled (KAFKA_CONSUMER_ENABLED=false); nothing is being read.",
      );
      return;
    }

    this.shutdown = new AbortController();
    this.subscription = await this.broker.subscribe({
      groupId: this.groupId,
      topics: [this.topic],
      // Only when the group is brand new. An existing group resumes from its
      // committed offsets, so a redeploy does not replay history — and a group
      // that has *never* run gets the retained log rather than silently missing
      // everything produced before it first started.
      fromBeginning: true,
      handle: (message) => this.handle(message),
    });
    this.logger.log(
      `Consuming ${this.topic} as group "${this.groupId}" via ${this.broker.name}; ` +
        `offsets are committed after each event, never before. ` +
        (this.deadLetters.enabled
          ? `Up to ${this.policy.maxAttempts} attempt(s) per message, then the dead-letter topic.`
          : `Dead-lettering is disabled; a message that cannot be handled blocks its partition.`),
    );
  }

  /** Leaves the group. Safe to call when `start` was skipped or never ran. */
  async stop(): Promise<void> {
    // Abort first, then wait. `RunningSubscription.stop()` waits for the handler
    // in flight, and a handler in the middle of a ladder is sleeping — so
    // without the abort, shutdown would take up to the ladder's whole budget per
    // partition rather than the milliseconds it takes to unwind one.
    this.shutdown.abort();
    await this.subscription?.stop();
    this.subscription = null;
  }

  private async handle(message: IncomingMessage): Promise<void> {
    let decoded: DecodedDomainEvent;
    try {
      decoded = decodeDomainEvent(message, this.contract);
    } catch (caught: unknown) {
      // Both skip the ladder for the same reason and are reported separately for
      // a different one: nothing about either becomes true on a second read, but
      // the two failures belong to different owners. See `DeadLetterReason`.
      if (caught instanceof SchemaContractViolationError) {
        await this.giveUp(message, "schema-invalid", 1, caught);
        return;
      }
      if (!(caught instanceof UndecodableMessageError)) throw caught;
      // Straight to the dead-letter topic, ladder skipped. One "attempt" is
      // recorded because one was made: the decode itself.
      await this.giveUp(message, "undecodable", 1, caught);
      return;
    }
    const event = decoded;

    const result = await runRetryLadder(
      async () => {
        const report = await this.bus.publishAndSettle(event.name, event.payload, {
          // The producer's identity and time, never fresh ones: a redelivery has
          // to look like the same event to a subscriber deduplicating on the id,
          // and `occurredAt` is when the transaction committed rather than when
          // the consumer got round to it. That holds across a retry too — the
          // ladder re-runs the same event, not a new one.
          eventId: event.eventId,
          occurredAt: event.occurredAt,
          correlationId: event.correlationId,
        });

        if (report.failed.length > 0) {
          throw new Error(
            `${report.failed.length} subscriber(s) failed for ${event.name} (${event.eventId}): ` +
              report.failed
                .map((outcome) => `${outcome.handler}: ${outcome.error ?? "unknown error"}`)
                .join("; "),
          );
        }
      },
      {
        policy: this.policy,
        random: this.random,
        signal: this.shutdown.signal,
        onRetry: (attempt, delayMs, error) => {
          this.logger.warn(
            `Attempt ${attempt}/${this.policy.maxAttempts} failed for ` +
              `${message.topic}/${message.partition}@${message.offset}; ` +
              `retrying in ${delayMs}ms: ${error instanceof Error ? error.message : String(error)}`,
          );
        },
      },
    );

    if (result.outcome === "exhausted") {
      await this.giveUp(message, "handler-failed", result.attempts, result.error);
    }
  }

  /**
   * The end of the line for one message.
   *
   * Returning normally is what commits the offset, so every path out of here is
   * a decision about whether this message is allowed to stop blocking its
   * partition. It is allowed only once a copy of it exists somewhere else —
   * which is why a failed `send` throws rather than being logged, and why the
   * disabled case rethrows rather than dropping.
   */
  private async giveUp(
    message: IncomingMessage,
    reason: DeadLetterReason,
    attempts: number,
    error: unknown,
  ): Promise<void> {
    if (!this.deadLetters.enabled) {
      // No dead-letter topic means no somewhere-else to put it, so the only
      // honest options are to block the partition or to lose the message. This
      // blocks: rethrowing withholds the commit and the message is redelivered
      // indefinitely, loudly, which is a stalled consumer an operator can see
      // rather than a gap in a stream nobody notices.
      this.logger.error(
        `Giving up on ${message.topic}/${message.partition}@${message.offset} after ` +
          `${attempts} attempt(s) [${reason}], but KAFKA_DEAD_LETTER_ENABLED=false — the ` +
          `message is not committed and will block this partition until it is handled or ` +
          `the topic is configured.`,
      );
      throw error instanceof Error ? error : new Error(String(error));
    }

    // Throws `DeadLetterPublishError` if the copy did not land, which withholds
    // the commit: the consumer has stopped trying to handle this message, so
    // committing without a copy of it anywhere would delete it outright.
    await this.deadLetters.send(message, {
      groupId: this.groupId,
      reason,
      attempts,
      error,
      failedAt: new Date(),
    });
  }
}
