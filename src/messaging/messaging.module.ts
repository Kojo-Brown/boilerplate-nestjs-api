import {
  Global,
  Inject,
  Injectable,
  Logger,
  Module,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from "@nestjs/common";
import { ConfigModule, ConfigService } from "@nestjs/config";
import type { SASLOptions } from "kafkajs";
import type { Env } from "@/config/env.schema";
import { MESSAGE_BROKER, type MessageBroker } from "./ports";
import { DOMAIN_EVENTS_TOPIC } from "./messaging.tokens";
import { InMemoryBroker } from "./in-memory-broker";
import { KafkaBroker } from "./kafka-broker.service";
import { BrokerOutboxPublisher } from "./broker-outbox.publisher";
import { DomainEventConsumer } from "./domain-event-consumer.service";

/**
 * Owns the order in which messaging starts and stops.
 *
 * One hook rather than one per provider, because the steps are ordered and Nest
 * does not order `onApplicationBootstrap` between providers of a module:
 * connect, then declare the topic, then join the group. A consumer that
 * subscribed before the topic existed would join a group with nothing to read
 * and stay that way until a metadata refresh happened to notice — which
 * `allowAutoTopicCreation: false` makes the *correct* behaviour of the broker
 * and a silent outage of the service.
 *
 * Connecting at bootstrap rather than lazily is what makes an unreachable
 * cluster a failed deployment instead of a 500 on whichever request happened to
 * publish first. Shutdown runs in reverse, and it runs even for a broker the
 * factory built and nothing used: a KafkaJS client with a live socket keeps the
 * event loop open, and a process that will not exit on `SIGTERM` is killed by
 * the orchestrator instead, mid-request.
 */
@Injectable()
class MessagingLifecycle implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger("MessagingModule");

  constructor(
    @Inject(MESSAGE_BROKER) private readonly broker: MessageBroker,
    @Inject(DOMAIN_EVENTS_TOPIC) private readonly topic: string,
    private readonly consumer: DomainEventConsumer,
    private readonly config: ConfigService<Env, true>,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.broker.connect();
    if (this.config.get("KAFKA_ENSURE_TOPICS", { infer: true })) {
      const partitions = this.config.get("KAFKA_TOPIC_PARTITIONS", { infer: true });
      await this.broker.ensureTopics([{ topic: this.topic, partitions }]);
    } else {
      this.logger.log(`KAFKA_ENSURE_TOPICS=false; expecting "${this.topic}" to exist already.`);
    }
    await this.consumer.start();
  }

  async onApplicationShutdown(): Promise<void> {
    // The consumer first, so a handler in flight commits rather than having its
    // message redelivered to whoever takes the partition next; then the broker,
    // which closes the producer and the admin client with it.
    await this.consumer.stop();
    await this.broker.disconnect();
  }
}

/**
 * Provides the process's single `MESSAGE_BROKER`, the domain-event consumer, and
 * the outbox publisher that produces to it.
 *
 * Global for the same reason `WorkersModule` is: a broker client owns
 * connections, a producer's idempotence is per-client, and a second one in the
 * same process would mean two sets of both. `OutboxModule` is the one consumer
 * of `BrokerOutboxPublisher` today, and it takes it by token — which is why this
 * module knows nothing about the outbox beyond the port it implements.
 */
@Global()
@Module({
  imports: [ConfigModule],
  providers: [
    {
      provide: DOMAIN_EVENTS_TOPIC,
      useFactory: (config: ConfigService<Env, true>): string =>
        config.get("KAFKA_DOMAIN_EVENTS_TOPIC", { infer: true }),
      inject: [ConfigService],
    },
    {
      provide: MESSAGE_BROKER,
      useFactory: (config: ConfigService<Env, true>): MessageBroker => {
        const backend = config.get("MESSAGE_BROKER", { infer: true });
        const logger = new Logger("MessagingModule");

        if (backend === "kafka") {
          const brokers = splitList(config.get("KAFKA_BROKERS", { infer: true }) ?? "");
          logger.log(`Kafka broker: ${brokers.join(",")}`);
          return new KafkaBroker({
            clientId: config.get("KAFKA_CLIENT_ID", { infer: true }),
            brokers,
            ssl: config.get("KAFKA_SSL", { infer: true }),
            sasl: saslFrom(config),
            connectionTimeoutMs: config.get("KAFKA_CONNECTION_TIMEOUT_MS", { infer: true }),
            requestTimeoutMs: config.get("KAFKA_REQUEST_TIMEOUT_MS", { infer: true }),
            sessionTimeoutMs: config.get("KAFKA_SESSION_TIMEOUT_MS", { infer: true }),
            heartbeatIntervalMs: config.get("KAFKA_HEARTBEAT_INTERVAL_MS", { infer: true }),
            redeliveryDelayMs: config.get("KAFKA_REDELIVERY_DELAY_MS", { infer: true }),
            subscribeTimeoutMs: config.get("KAFKA_SUBSCRIBE_TIMEOUT_MS", { infer: true }),
            handlerTimeoutMs: config.get("KAFKA_HANDLER_TIMEOUT_MS", { infer: true }),
          });
        }

        logger.log(
          "In-memory broker: messages stay in this process and are lost on restart. " +
            "Set MESSAGE_BROKER=kafka for anything that has to reach another replica.",
        );
        return new InMemoryBroker({
          defaultPartitions: config.get("KAFKA_TOPIC_PARTITIONS", { infer: true }),
          handlerTimeoutMs: config.get("KAFKA_HANDLER_TIMEOUT_MS", { infer: true }),
        });
      },
      inject: [ConfigService],
    },
    BrokerOutboxPublisher,
    DomainEventConsumer,
    MessagingLifecycle,
  ],
  exports: [MESSAGE_BROKER, DOMAIN_EVENTS_TOPIC, BrokerOutboxPublisher],
})
export class MessagingModule {}

function splitList(value: string): string[] {
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

/**
 * SASL credentials, or nothing.
 *
 * `undefined` rather than a mechanism with empty strings: KafkaJS authenticates
 * when `sasl` is present, so a half-filled object fails the handshake with a
 * message about the credentials rather than about the configuration. The schema
 * refuses that combination at boot anyway; this is the second half of the same
 * rule, kept next to the code that would otherwise construct it.
 */
function saslFrom(config: ConfigService<Env, true>): SASLOptions | undefined {
  const mechanism = config.get("KAFKA_SASL_MECHANISM", { infer: true });
  if (!mechanism) return undefined;

  const username = config.get("KAFKA_SASL_USERNAME", { infer: true }) ?? "";
  const password = config.get("KAFKA_SASL_PASSWORD", { infer: true }) ?? "";
  // A `switch` rather than `{ mechanism, username, password } as SASLOptions`.
  // `SASLOptions` is a union discriminated on `mechanism`, and a variable of the
  // union type does not narrow the object built around it — so the shorter form
  // needs a cast, and a cast here would also accept the OAuth and AWS variants,
  // which take a callback rather than a password and would fail at the
  // handshake. The exhaustiveness is the point: adding a mechanism to the schema
  // without wiring it becomes a compile error.
  switch (mechanism) {
    case "plain":
      return { mechanism: "plain", username, password };
    case "scram-sha-256":
      return { mechanism: "scram-sha-256", username, password };
    case "scram-sha-512":
      return { mechanism: "scram-sha-512", username, password };
  }
}
