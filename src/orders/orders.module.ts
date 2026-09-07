import { Module } from "@nestjs/common";
import { PaymentsModule } from "@/payments/payments.module";
import { CheckoutSaga } from "./checkout.saga";
import { OrdersController } from "./orders.controller";
import { PrismaOrderStore } from "./prisma-order.store";
import { InMemoryInventoryService } from "./services/in-memory-inventory.service";
import { InMemoryShippingService } from "./services/in-memory-shipping.service";
import { INVENTORY_SERVICE, ORDER_STORE, SHIPPING_SERVICE } from "./ports";
import { ORDERS_QUERY_HANDLERS } from "./read";
import { ORDERS_COMMAND_HANDLERS } from "./write";

/**
 * The orders module: one saga definition, its participants, and the HTTP edge.
 *
 * It imports `PaymentsModule` for the gateway factory and nothing else. The
 * saga engine, the outbox and the transaction runner are all global, so the
 * checkout is wired by depending on tokens rather than by importing modules —
 * which is what lets `CheckoutSaga` be the only file that knows the order of
 * the steps.
 *
 * The two in-process participants are bound here, and here only. In a
 * deployment where inventory and shipping are other people's services, this
 * file changes and nothing else does: the saga, the orchestrator and the tests
 * all talk to `INVENTORY_SERVICE` and `SHIPPING_SERVICE`.
 */
@Module({
  imports: [PaymentsModule],
  controllers: [OrdersController],
  providers: [
    CheckoutSaga,
    ...ORDERS_COMMAND_HANDLERS,
    ...ORDERS_QUERY_HANDLERS,
    { provide: ORDER_STORE, useClass: PrismaOrderStore },
    { provide: INVENTORY_SERVICE, useClass: InMemoryInventoryService },
    { provide: SHIPPING_SERVICE, useClass: InMemoryShippingService },
  ],
  // Nothing leaves. Everything this module can do is reached by dispatching a
  // command or a query, which needs no import edge at all.
  exports: [],
})
export class OrdersModule {}
