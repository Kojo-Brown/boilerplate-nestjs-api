import { Inject, Logger } from "@nestjs/common";
import { Command, CommandHandler } from "@nestjs/cqrs";
import type { ICommandHandler } from "@nestjs/cqrs";
import { randomUUID } from "crypto";
import { TRANSACTION_RUNNER } from "@/common/prisma/transaction.port";
import type { TransactionRunner } from "@/common/prisma/transaction.port";
import { TransactionalOutbox } from "@/outbox";
import { SagaOrchestrator } from "@/saga";
import { CHECKOUT_SAGA, type CheckoutSagaState } from "../checkout.saga";
import { priceOrder } from "../catalogue";
import { ORDER_STORE, type OrderStore, type ReservedLine } from "../ports";
import type { OrderRecord } from "../order";

/** What the caller asked for, after validation and before pricing. */
export interface PlaceOrderInput {
  readonly lines: readonly ReservedLine[];
  /** ISO-3166 alpha-2, upper case. */
  readonly shippingCountry: string;
  readonly correlationId?: string | null;
}

/** Places an order and drives its checkout as far as it will go. */
export class PlaceOrderCommand extends Command<OrderRecord> {
  constructor(
    readonly userId: string,
    readonly input: PlaceOrderInput,
  ) {
    super();
  }
}

@CommandHandler(PlaceOrderCommand)
export class PlaceOrderHandler implements ICommandHandler<PlaceOrderCommand> {
  private readonly logger = new Logger(PlaceOrderHandler.name);

  constructor(
    @Inject(ORDER_STORE) private readonly orders: OrderStore,
    @Inject(TRANSACTION_RUNNER) private readonly transactions: TransactionRunner,
    private readonly outbox: TransactionalOutbox,
    private readonly sagas: SagaOrchestrator,
  ) {}

  /**
   * Two phases, and the boundary between them is the point of the whole
   * feature.
   *
   * **Inside the transaction**, three things that must be true together: the
   * order row, the saga that will drive it, and the `order.placed` event. An
   * order without a saga is an order nothing will ever advance; a saga without
   * an order is a saga about nothing; an event without either describes
   * something that did not happen. Nothing remote happens here — a payment
   * gateway inside a transaction holds a database connection for the length of
   * somebody else's network call.
   *
   * **After it commits**, the saga is advanced. That call is an optimisation
   * rather than a requirement, and saying so is what makes the design durable:
   * if this process dies before it, or during it, `SagaRecoveryService` claims
   * the instance on its next poll and carries on from the step the row says it
   * reached. What the caller gets by it is a checkout that answers with the
   * finished order instead of a job id, in the ordinary case where nothing goes
   * wrong.
   *
   * The order is re-read rather than taken from the advance, because the steps
   * write it and the saga's own record says nothing about what they wrote.
   */
  async execute({ userId, input }: PlaceOrderCommand): Promise<OrderRecord> {
    const priced = priceOrder(input.lines);
    // Minted here rather than by the database, because the saga's state has to
    // carry the order id and the saga is created in the same statement batch as
    // the order. Waiting for a server-assigned id would mean a second write to
    // put it into the state.
    const orderId = randomUUID();

    const { order, sagaId } = await this.transactions.run(async (tx) => {
      const state: CheckoutSagaState = {
        orderId,
        userId,
        currency: priced.total.currency,
        totalMinor: priced.total.amountMinor,
        shippingCountry: input.shippingCountry.toUpperCase(),
        lines: input.lines.map((line) => ({ ...line })),
        reservationId: null,
        paymentId: null,
        shipmentId: null,
      };
      const saga = await this.sagas.start(tx, CHECKOUT_SAGA, state, {
        correlationId: input.correlationId ?? null,
      });

      const created = await this.orders.create(tx, {
        id: orderId,
        userId,
        items: priced.items,
        total: priced.total,
        shippingCountry: state.shippingCountry,
        sagaId: saga.id,
      });

      await this.outbox.stage(
        tx,
        "order.placed",
        {
          orderId,
          userId,
          totalMinor: priced.total.amountMinor,
          currency: priced.total.currency,
          lineCount: priced.items.length,
        },
        { correlationId: input.correlationId ?? null },
      );

      return { order: created, sagaId: saga.id };
    });

    try {
      await this.sagas.advance(sagaId);
    } catch (caught: unknown) {
      // The saga machinery itself failed — not a step, which the orchestrator
      // handles. The order and its instance are committed, so the recovery
      // poller will pick it up; answering the caller with the order as it
      // stands is strictly better than a 500 for a checkout that is still very
      // much alive.
      const message = caught instanceof Error ? caught.message : String(caught);
      this.logger.error(`Order ${orderId} was placed but could not be advanced: ${message}`);
    }

    return (await this.orders.find(orderId)) ?? order;
  }
}
