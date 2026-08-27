export { MessagingModule } from "./messaging.module";
export { InMemoryBroker } from "./in-memory-broker";
export type { InMemoryBrokerOptions } from "./in-memory-broker";
export { KafkaBroker } from "./kafka-broker.service";
export type { KafkaBrokerOptions } from "./kafka-broker.service";
export { BrokerOutboxPublisher } from "./broker-outbox.publisher";
export { DomainEventConsumer } from "./domain-event-consumer.service";
export { DOMAIN_EVENTS_TOPIC } from "./messaging.tokens";
export {
  EVENT_CONTENT_TYPE,
  EVENT_HEADERS,
  decodeDomainEvent,
  encodeDomainEvent,
  partitionKeyFor,
} from "./domain-event-codec";
export type { EncodedDomainEvent } from "./domain-event-codec";
export {
  BrokerClosedError,
  HandlerTimeoutError,
  SubscriptionTimeoutError,
  UndecodableMessageError,
} from "./messaging.errors";
export { MESSAGE_BROKER, MESSAGE_BROKER_NAMES, nextOffset } from "./ports";
export type {
  IncomingMessage,
  MessageBroker,
  MessageBrokerName,
  OutgoingMessage,
  RunningSubscription,
  SubscriptionOptions,
  TopicSpec,
} from "./ports";
