import { Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { ConfigModule } from "@nestjs/config";
import { ThrottlerModule } from "@nestjs/throttler";
import { PrismaModule } from "./common/prisma/prisma.module";
import { AppCacheModule } from "./common/cache";
import { IdempotencyModule } from "./common/idempotency";
import { LockingModule } from "./common/locking";
import { AspectsModule } from "./common/aspects";
import { AppCqrsModule } from "./cqrs";
import { EventsModule } from "./events";
import { MessagingModule } from "./messaging";
import { OutboxModule } from "./outbox";
import { SchemaRegistryModule } from "./schema-registry";
import { SagaModule } from "./saga";
import { DiScopesModule } from "./di-scopes";
import { UsersModule } from "./users/users.module";
import { AuthModule } from "./auth/auth.module";
import { StorageModule } from "./storage/storage.module";
import { PaymentsModule } from "./payments/payments.module";
import { OrdersModule } from "./orders";
import { NotificationsModule } from "./notifications/notifications.module";
import { HealthModule } from "./health/health.module";
import { StreamingModule } from "./streaming";
import { RealtimeModule } from "./realtime";
import { QueueModule } from "./queue/queue.module";
import { WorkersModule } from "./workers/workers.module";
import { ShutdownModule } from "./common/shutdown/shutdown.module";
import { ProxyAwareThrottlerGuard } from "./common/guards/throttler.guard";
import { envSchema } from "./config/env.schema";

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validate: (config) => envSchema.parse(config),
    }),
    ThrottlerModule.forRoot([{ name: "default", ttl: 60_000, limit: 100 }]),
    PrismaModule,
    AppCacheModule,
    // Global, and before AspectsModule: `AspectWeaver` installs `@Lock()` from
    // the `DISTRIBUTED_LOCK` this binds, and refuses to boot without it.
    LockingModule,
    // After AppCacheModule: `ASPECT_CACHE` is an alias of its `CacheService`.
    AspectsModule,
    // Global: `IdempotencyInterceptor` is bound in main.ts, outside any module.
    IdempotencyModule,
    // Global: any module publishes through `DomainEventBus`, and subscribers
    // are discovered wherever they are declared.
    EventsModule,
    // Global, and after EventsModule: `DomainEventCqrsBridge` is an
    // `@OnDomainEvent` subscriber that forwards every domain event onto the
    // CQRS `EventBus`. Registering `CqrsModule.forRoot()` here and only here is
    // what makes one set of buses serve the whole container.
    AppCqrsModule,
    // Global, and before both MessagingModule and OutboxModule: each takes
    // `EventContract` to check a payload against the schema registered for its
    // event — the outbox before the row is written, the codec on and off the
    // wire.
    SchemaRegistryModule,
    // Global, and after EventsModule: `DomainEventConsumer` puts what it reads
    // off the topic onto `DomainEventBus`. Before OutboxModule, which takes
    // `BrokerOutboxPublisher` from here when `OUTBOX_PUBLISHER=broker`.
    MessagingModule,
    // Global, and after EventsModule: the relay's default publisher delivers
    // through `DomainEventBus`. Any module that writes something worth
    // announcing stages it here.
    OutboxModule,
    // Global, and after OutboxModule: a saga step stages events through
    // `TransactionalOutbox`, and `SagaRecoveryService` starts polling on
    // `onApplicationBootstrap` — after every module's `onModuleInit`, which is
    // where a definition registers itself. See src/saga/saga.module.ts.
    SagaModule,
    AuthModule,
    UsersModule,
    StorageModule,
    PaymentsModule,
    // After SagaModule and PaymentsModule: `CheckoutSaga` registers the
    // `order.checkout` definition and charges through `PaymentProviderFactory`.
    OrdersModule,
    NotificationsModule,
    HealthModule,
    QueueModule,
    // After EventsModule and MessagingModule: `EventStreamHub` subscribes to
    // `DomainEventBus`, so it fans out events relayed from this instance's
    // outbox and events `DomainEventConsumer` read off the topic alike.
    StreamingModule,
    // After EventsModule and MessagingModule, for the same reason
    // StreamingModule is: `RealtimeGateway` is another `@OnDomainEvent`
    // subscriber, so it fans out locally relayed events and events read off the
    // topic alike. Requires the `ws` adapter to be installed before `init()` —
    // see main.ts.
    RealtimeModule,
    // Global: `WORKER_POOL` is a scarce process-scoped resource, and every
    // caller wants the one the module provides — a second pool defeats the
    // point of a bounded queue.
    WorkersModule,
    ShutdownModule,
    // Teaching module: the three provider scopes, and `ScopeAudit`, which
    // reports at boot what the container rebuilds per request. See
    // docs/di-scopes.md. Safe to delete along with `src/di-scopes`.
    DiScopesModule,
  ],
  providers: [{ provide: APP_GUARD, useClass: ProxyAwareThrottlerGuard }],
})
export class AppModule {}
