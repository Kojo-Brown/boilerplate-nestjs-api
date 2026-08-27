import { Global, Logger, Module } from "@nestjs/common";
import { ConfigModule, ConfigService } from "@nestjs/config";
import type { Env } from "@/config/env.schema";
import { BrokerOutboxPublisher } from "@/messaging";
import { PrismaOutboxStore } from "./prisma-outbox.store";
import { DomainEventBusPublisher } from "./domain-event-bus.publisher";
import { OutboxRelayService } from "./outbox-relay.service";
import { TransactionalOutbox } from "./transactional-outbox.service";
import { OUTBOX_PUBLISHER, OUTBOX_STORE, type OutboxPublisher } from "./ports";

/**
 * Wires the outbox.
 *
 * Global for the same reason `EventsModule` is: any module that writes
 * something worth announcing stages an event, and making each one import this
 * would reintroduce the wiring the pattern exists to remove.
 *
 * Both halves are bound by token. The store because the e2e suite runs the
 * whole application on in-memory doubles and has no Postgres to claim rows
 * from; the publisher because it is the broker seam — and `OUTBOX_PUBLISHER`
 * now chooses between the two implementations that seam was built for.
 *
 * `BrokerOutboxPublisher` comes from `MessagingModule`, which is `@Global`, so
 * the dependency is one direction only: the outbox knows a publisher exists,
 * messaging knows nothing about the outbox beyond the port it implements.
 */
@Global()
@Module({
  imports: [ConfigModule],
  providers: [
    { provide: OUTBOX_STORE, useClass: PrismaOutboxStore },
    {
      provide: OUTBOX_PUBLISHER,
      useFactory: (
        config: ConfigService<Env, true>,
        bus: DomainEventBusPublisher,
        broker: BrokerOutboxPublisher,
      ): OutboxPublisher => {
        const selected = config.get("OUTBOX_PUBLISHER", { infer: true });
        const publisher = selected === "broker" ? broker : bus;
        new Logger("OutboxModule").log(
          selected === "broker"
            ? `Relaying to the broker via ${publisher.name}; every consumer group over the ` +
                `topic gets a copy.`
            : `Relaying to this process's DomainEventBus. Subscribers run only on the replica ` +
                `whose relay won the row — set OUTBOX_PUBLISHER=broker for fan-out.`,
        );
        return publisher;
      },
      inject: [ConfigService, DomainEventBusPublisher, BrokerOutboxPublisher],
    },
    // Both are constructed whichever is selected, which is cheap: neither opens
    // anything of its own — `BrokerOutboxPublisher` holds the broker the
    // messaging module already built, and the broker connects on its own
    // bootstrap hook rather than in a constructor.
    DomainEventBusPublisher,
    TransactionalOutbox,
    OutboxRelayService,
  ],
  exports: [TransactionalOutbox, OutboxRelayService, OUTBOX_STORE, OUTBOX_PUBLISHER],
})
export class OutboxModule {}
