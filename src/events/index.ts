export { DomainEventBus } from "./domain-event-bus.service";
export type { PublishContext, PublishReport } from "./domain-event-bus.service";
export { EventsModule } from "./events.module";
export { OnDomainEvent, isHandlerOutcome } from "./on-domain-event";

export type {
  DomainEvent,
  DomainEventHandler,
  DomainEventName,
  DomainEventPayloads,
  HandlerOutcome,
  UserDeletedPayload,
  UserRegisteredPayload,
} from "./domain-event";
