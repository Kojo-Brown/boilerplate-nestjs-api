import { Global, Module } from "@nestjs/common";
import { PrismaSagaStore } from "./prisma-saga.store";
import { SagaOrchestrator } from "./saga-orchestrator.service";
import { SagaRecoveryService } from "./saga-recovery.service";
import { SagaRegistry } from "./saga-registry";
import { SAGA_STORE } from "./ports";

/**
 * The saga engine, with no saga in it.
 *
 * Global for the reason `OutboxModule` and `EventsModule` are: any module may
 * define a saga, and making each one import this would reintroduce the wiring
 * the registry removes. Definitions live in the module that owns the process
 * they describe — `order.checkout` is in `src/orders` — and register themselves
 * from `onModuleInit`.
 *
 * `SagaRecoveryService` starts a poll on `onApplicationBootstrap`, which is
 * after every module's `onModuleInit`, so it never polls before the registry is
 * populated. That ordering is the whole reason registration happens where it
 * does.
 */
@Global()
@Module({
  providers: [
    SagaRegistry,
    // Bound by token so the orchestrator depends on the port rather than on
    // Prisma, and so the e2e suite can substitute `InMemorySagaStore` without
    // a database — exactly as `OUTBOX_STORE` is bound.
    { provide: SAGA_STORE, useClass: PrismaSagaStore },
    SagaOrchestrator,
    SagaRecoveryService,
  ],
  exports: [SagaRegistry, SagaOrchestrator, SagaRecoveryService, SAGA_STORE],
})
export class SagaModule {}
