import { Inject, Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { Env } from "@/config/env.schema";
import { DomainEventBus } from "@/events";
import { MESSAGE_BROKER, type IncomingMessage, type MessageBroker } from "./ports";
import { DOMAIN_EVENTS_TOPIC } from "./messaging.tokens";
import { decodeDomainEvent } from "./domain-event-codec";
import { UndecodableMessageError } from "./messaging.errors";

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
 * `publishAndSettle` reports every subscriber's outcome, and one failure rejects
 * the handler. `MessageBroker` treats that as "not handled": the offset is not
 * committed and the message is redelivered — which means the subscribers that
 * already succeeded run again. That is the same at-least-once bargain the outbox
 * relay already made with the same bus (`docs/outbox.md`, *Not per-handler
 * retry*), and it is why `@OnDomainEvent` handlers have to be idempotent.
 *
 * A message that cannot be *decoded* is the one thing that is not retried, and
 * it is a deliberate exception rather than an oversight — see the handler.
 */
@Injectable()
export class DomainEventConsumer {
  private readonly logger = new Logger(DomainEventConsumer.name);

  private readonly enabled: boolean;
  private readonly groupId: string;
  private subscription: { stop(): Promise<void> } | null = null;

  constructor(
    @Inject(MESSAGE_BROKER) private readonly broker: MessageBroker,
    @Inject(DOMAIN_EVENTS_TOPIC) private readonly topic: string,
    private readonly bus: DomainEventBus,
    config: ConfigService<Env, true>,
  ) {
    this.enabled = config.get("KAFKA_CONSUMER_ENABLED", { infer: true });
    this.groupId = config.get("KAFKA_CONSUMER_GROUP_ID", { infer: true });
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
        `offsets are committed after each event, never before.`,
    );
  }

  /** Leaves the group. Safe to call when `start` was skipped or never ran. */
  async stop(): Promise<void> {
    await this.subscription?.stop();
    this.subscription = null;
  }

  private async handle(message: IncomingMessage): Promise<void> {
    let event;
    try {
      event = decodeDomainEvent(message);
    } catch (caught: unknown) {
      if (!(caught instanceof UndecodableMessageError)) throw caught;
      // Committed past, not retried, and this is the one place in the pipeline
      // where a failure is not redelivered. The reason is that redelivery
      // cannot help: bytes that are not a domain event this build recognises
      // will not become one by being read again, so retrying blocks the
      // partition forever over a message no version of this code can handle —
      // and takes every well-formed event behind it down with it.
      //
      // Committing past it drops the message, which is a real loss and is why
      // this logs at error with the coordinates needed to read the record back
      // off the topic by hand. Phase 10 item 2 gives it somewhere to go
      // instead; until then, dropping one undecodable message beats stalling
      // the partition.
      this.logger.error(
        `Skipping an undecodable message on ${message.topic}/${message.partition}` +
          `@${message.offset}: ${caught.message}`,
      );
      return;
    }

    const report = await this.bus.publishAndSettle(event.name, event.payload, {
      // The producer's identity and time, never fresh ones: a redelivery has to
      // look like the same event to a subscriber deduplicating on the id, and
      // `occurredAt` is when the transaction committed rather than when the
      // consumer got round to it.
      eventId: event.eventId,
      occurredAt: event.occurredAt,
      correlationId: event.correlationId,
    });

    if (report.failed.length > 0) {
      // Rejecting is what withholds the commit. The message is redelivered and
      // the whole event is handled again, successful subscribers included.
      throw new Error(
        `${report.failed.length} subscriber(s) failed for ${event.name} (${event.eventId}): ` +
          report.failed
            .map((outcome) => `${outcome.handler}: ${outcome.error ?? "unknown error"}`)
            .join("; "),
      );
    }
  }
}
