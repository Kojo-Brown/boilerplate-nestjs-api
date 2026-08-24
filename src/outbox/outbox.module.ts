import { Global, Module } from "@nestjs/common";
import { PrismaOutboxStore } from "./prisma-outbox.store";
import { DomainEventBusPublisher } from "./domain-event-bus.publisher";
import { OutboxRelayService } from "./outbox-relay.service";
import { TransactionalOutbox } from "./transactional-outbox.service";
import { OUTBOX_PUBLISHER, OUTBOX_STORE } from "./ports";

/**
 * Wires the outbox.
 *
 * Global for the same reason `EventsModule` is: any module that writes
 * something worth announcing stages an event, and making each one import this
 * would reintroduce the wiring the pattern exists to remove.
 *
 * Both halves are bound by token. The store because the e2e suite runs the
 * whole application on in-memory doubles and has no Postgres to claim rows
 * from; the publisher because it is the broker seam — Phase 10's Kafka producer
 * replaces this binding and nothing else.
 */
@Global()
@Module({
  providers: [
    { provide: OUTBOX_STORE, useClass: PrismaOutboxStore },
    { provide: OUTBOX_PUBLISHER, useClass: DomainEventBusPublisher },
    TransactionalOutbox,
    OutboxRelayService,
  ],
  exports: [TransactionalOutbox, OutboxRelayService, OUTBOX_STORE, OUTBOX_PUBLISHER],
})
export class OutboxModule {}
