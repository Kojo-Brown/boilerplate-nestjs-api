import { Inject, Injectable, Logger, Optional } from "@nestjs/common";
import { MESSAGE_BROKER, type IncomingMessage, type MessageBroker } from "./ports";
import { DEAD_LETTER_TOPIC } from "./messaging.tokens";
import { describeError, toDeadLetterMessage, type DeadLetterContext } from "./dead-letter";
import { DeadLetterPublishError } from "./messaging.errors";

/**
 * Where a message goes when this service has given up on it.
 *
 * The dead-letter topic is an ordinary Kafka topic and this is an ordinary
 * producer onto it, which is most of the point: a dead letter is readable by
 * `kafka-console-consumer`, redrivable by producing it back to its origin topic,
 * and subject to the same retention as anything else — so it needs a retention
 * long enough to be noticed, and an alert on its rate, neither of which code in
 * this repository can provide.
 *
 * ### Nothing consumes it
 *
 * Deliberately. A dead-letter topic that is automatically drained back into the
 * main topic is a retry loop with extra steps, and the failure it produces —
 * events cycling between two topics forever — is harder to see than the poison
 * message it was meant to solve. Redriving is a human decision made after the
 * cause is fixed, which is also why {@link DEAD_LETTER_HEADERS} carries the
 * origin partition and offset: enough to find the original and produce it back.
 *
 * ### It is optional, and off means the old behaviour
 *
 * `KAFKA_DEAD_LETTER_ENABLED=false` binds `DEAD_LETTER_TOPIC` to `null` and this
 * provider reports `enabled === false`. `DomainEventConsumer` then does what it
 * did before there was a dead-letter topic: an exhausted ladder rethrows and the
 * message is redelivered forever. That is a legitimate choice for a deployment
 * that would rather stall a partition than continue past an event it could not
 * handle — losing ordering is worse than losing availability for some streams —
 * and it is why the switch exists rather than being hardcoded to on.
 */
@Injectable()
export class DeadLetterQueue {
  private readonly logger = new Logger(DeadLetterQueue.name);

  constructor(
    @Inject(MESSAGE_BROKER) private readonly broker: MessageBroker,
    // `@Optional()` because `DEAD_LETTER_TOPIC` is bound to `null` rather than
    // left unprovided when dead-lettering is off — but a test constructing this
    // class directly should not have to pass a token to say "no topic".
    @Optional() @Inject(DEAD_LETTER_TOPIC) private readonly topic: string | null = null,
  ) {}

  get enabled(): boolean {
    return this.topic !== null;
  }

  /**
   * Copies `message` to the dead-letter topic.
   *
   * Rejects with {@link DeadLetterPublishError} if the produce fails, and the
   * caller must not commit when it does — see that error. Calling this while
   * dead-lettering is disabled is a programming error rather than a no-op:
   * silently doing nothing here would make an exhausted ladder drop the message,
   * which is the one outcome nothing in this design ever chooses.
   */
  async send(message: IncomingMessage, context: DeadLetterContext): Promise<void> {
    const topic = this.topic;
    if (topic === null) {
      throw new Error(
        "DeadLetterQueue.send was called with dead-lettering disabled. Check `enabled` first.",
      );
    }

    try {
      await this.broker.produce([toDeadLetterMessage(topic, message, context)]);
    } catch (caught: unknown) {
      throw new DeadLetterPublishError(topic, caught);
    }

    // At `error`, not `warn`. A dead letter is an event that this service
    // accepted, could not handle, and has now stopped trying to handle: it needs
    // a human, and the coordinates here are what that human starts from.
    this.logger.error(
      `Dead-lettered ${message.topic}/${message.partition}@${message.offset} to ${topic} ` +
        `after ${context.attempts} attempt(s) [${context.reason}]: ${describeError(context.error)}`,
    );
  }
}
