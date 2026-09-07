import { Inject, Injectable, Logger, type OnModuleInit } from "@nestjs/common";
import { TRANSACTION_RUNNER } from "@/common/prisma/transaction.port";
import type { TransactionRunner } from "@/common/prisma/transaction.port";
import { TransactionalOutbox } from "@/outbox";
import { PaymentProviderFactory } from "@/payments/payment-provider.factory";
import { PaymentStateError } from "@/payments/payment.errors";
import type { Money } from "@/payments/money";
import type { Payment, PaymentProvider } from "@/payments/ports";
import { SagaRegistry, UnretryableStepError, defineSaga } from "@/saga";
import type { SagaDefinition, SagaStep } from "@/saga";
import { OutOfStockError, UnservicedDestinationError } from "./orders.errors";
import {
  INVENTORY_SERVICE,
  ORDER_STORE,
  SHIPPING_SERVICE,
  type InventoryService,
  type OrderStore,
  type ReservedLine,
  type ShippingService,
} from "./ports";

/** The name the definition is registered and persisted under. */
export const CHECKOUT_SAGA = "order.checkout";

/**
 * What a checkout knows.
 *
 * A type alias rather than an interface, because it has to be assignable to
 * `SagaState` — see `src/saga/saga-state.ts`. The three ids start `null` and
 * are filled in by the step that learns them, which is also how a resumed saga
 * can tell "not yet" from "never".
 */
export type CheckoutSagaState = {
  readonly orderId: string;
  readonly userId: string;
  /** Upper-case ISO 4217. */
  readonly currency: string;
  /** Integer minor units. Recomputed from the order's lines, never client input. */
  readonly totalMinor: number;
  /** ISO-3166 alpha-2. */
  readonly shippingCountry: string;
  readonly lines: readonly ReservedLine[];
  readonly reservationId: string | null;
  readonly paymentId: string | null;
  readonly shipmentId: string | null;
};

/**
 * The checkout saga: five steps across four services, and one way back.
 *
 * ```
 *   accept-order ─→ reserve-stock ─→ charge-payment ─→ create-shipment ─→ confirm-order
 *   compensatable   compensatable    compensatable     PIVOT              retriable
 *        ↑               ↑                 ↑              │                   │
 *   cancel-order    release-stock     refund-payment      └── no way back ─────┘
 * ```
 *
 * The order of the first three is not arbitrary and is worth reading as a
 * design rather than a list. Stock is held *before* the card is charged,
 * because releasing a hold is free and refunding is not: a customer who sees a
 * charge and a refund on their statement has had a worse experience than one
 * who was told the item was gone, even though the system ends in the same
 * state. Payment comes before shipping for the same reason in the other
 * direction — a parcel cannot be recalled, so nothing may be dispatched until
 * the money is in.
 *
 * `create-shipment` is the **pivot**, and the port says why: `ShippingService`
 * has no `cancelShipment`, because a carrier that has the parcel cannot be told
 * the sale is off. Everything before it can be undone; nothing after it can.
 * `confirm-order` is therefore `retriable` — it only writes a row and stages an
 * event, and if it fails it must keep being tried, because the alternative is a
 * customer whose money is gone and whose order says `PROCESSING`.
 *
 * Every step is idempotent on `context.idempotencyKey`, which the orchestrator
 * guarantees is stable across attempts of one step and distinct between steps.
 * That is not a nicety here — the saga is at-least-once, so each of these
 * *will* run twice eventually, and the second run must be free.
 */
@Injectable()
export class CheckoutSaga implements OnModuleInit {
  private readonly logger = new Logger(CheckoutSaga.name);

  readonly definition: SagaDefinition<CheckoutSagaState>;

  constructor(
    @Inject(ORDER_STORE) private readonly orders: OrderStore,
    @Inject(INVENTORY_SERVICE) private readonly inventory: InventoryService,
    @Inject(SHIPPING_SERVICE) private readonly shipping: ShippingService,
    private readonly payments: PaymentProviderFactory,
    @Inject(TRANSACTION_RUNNER) private readonly transactions: TransactionRunner,
    private readonly outbox: TransactionalOutbox,
    private readonly registry: SagaRegistry,
  ) {
    this.definition = defineSaga<CheckoutSagaState>(CHECKOUT_SAGA, [
      this.acceptOrder(),
      this.reserveStock(),
      this.chargePayment(),
      this.createShipment(),
      this.confirmOrder(),
    ]);
  }

  /**
   * Registers from `onModuleInit` rather than from the module's provider list,
   * because the registry has to be populated before `SagaRecoveryService` polls
   * — and Nest runs every `onModuleInit` before any `onApplicationBootstrap`,
   * which is where that poll starts. See `SagaRegistry`.
   */
  onModuleInit(): void {
    this.registry.register(this.definition);
  }

  /**
   * Moves the order out of `PENDING`, and owns the cancellation on the way back.
   *
   * It looks like a step that does nothing worth a network call, and it is not:
   * making it the *first* step is what gives the saga somewhere to write the
   * outcome. A saga whose first step were `reserve-stock` would have no step to
   * compensate when stock ran out, and the order would sit `PENDING` forever
   * with the reason known only to a log line.
   */
  private acceptOrder(): SagaStep<CheckoutSagaState> {
    return {
      name: "accept-order",
      kind: "compensatable",
      execute: async ({ state }) => {
        const order = await this.orders.find(state.orderId);
        if (!order) throw new Error(`Order ${state.orderId} no longer exists.`);
        // Only `PENDING` moves. Writing `PROCESSING` unconditionally would be
        // idempotent for a re-run of this step, which is the case that happens
        // — but it would also *rewind* an order that had reached `CONFIRMED` or
        // `CANCELLED`, and the last step would then stage a second
        // `order.confirmed` for an order already confirmed. Guarding on the
        // status costs a read and makes the step idempotent for the right
        // reason rather than by coincidence.
        if (order.status !== "PENDING") return;

        await this.transactions.run((tx) =>
          this.orders.transition(tx, state.orderId, { status: "PROCESSING" }),
        );
      },
      compensate: async ({ state, failure }) => {
        const order = await this.orders.find(state.orderId);
        // Nothing to undo, and both readings of that are ordinary: the order
        // was deleted (a cascading account deletion), or a previous attempt at
        // this very compensation already cancelled it and its lease expired
        // before it could say so.
        if (!order || order.status === "CANCELLED") return;

        const reason = failure?.message ?? "Checkout could not be completed";
        await this.transactions.run(async (tx) => {
          await this.orders.transition(tx, state.orderId, {
            status: "CANCELLED",
            failureReason: reason,
          });
          // Staged with the status change rather than published after it. By
          // the time a subscriber reads this, the stock is back and any charge
          // is refunded — the compensations that ran before this one — which is
          // what makes the event safe to act on.
          await this.outbox.stage(tx, "order.cancelled", {
            orderId: state.orderId,
            userId: state.userId,
            reason,
          });
        });
      },
    };
  }

  private reserveStock(): SagaStep<CheckoutSagaState> {
    return {
      name: "reserve-stock",
      kind: "compensatable",
      execute: async ({ state, idempotencyKey }) => {
        try {
          const reservation = await this.inventory.reserve({
            orderId: state.orderId,
            lines: state.lines,
            reservationId: idempotencyKey,
          });
          return { reservationId: reservation.id };
        } catch (error: unknown) {
          // An empty shelf is an answer, not an outage. Retrying it on the
          // ladder would spend half a minute proving what the first call
          // already established, and would delay telling the customer by
          // exactly that much.
          if (error instanceof OutOfStockError) {
            throw new UnretryableStepError(error.message, error);
          }
          throw error;
        }
      },
      compensate: async ({ idempotencyKey }) => {
        // Addressed by the key rather than by `state.reservationId`, and the
        // difference is the whole reason `reserve` takes a caller-assigned id.
        // A reserve whose response was lost leaves `state.reservationId` null
        // and the stock held; releasing by key finds it anyway. Releasing by
        // state would silently leave it committed to an order that has just
        // been cancelled.
        await this.inventory.release(idempotencyKey);
      },
    };
  }

  /**
   * Authorises and captures in one step, compensated by a refund.
   *
   * One step rather than two because the port has no `void`: with
   * authorise-then-capture as separate steps, a capture that failed would need
   * its predecessor's compensation to cancel an authorisation, and neither
   * Stripe's nor PayPal's cancel is on `PaymentProvider`. Doing both here means
   * the only state this step can leave behind is "captured" — which `refund`
   * does undo — or "authorised and never captured", which lapses at the
   * provider on its own.
   */
  private chargePayment(): SagaStep<CheckoutSagaState> {
    return {
      name: "charge-payment",
      kind: "compensatable",
      execute: async ({ state, idempotencyKey }) => {
        const provider = this.payments.defaultProvider;
        // The reference doubles as the gateway's idempotency key — see
        // `CreatePaymentInput.reference` — so a retry after a lost response
        // returns the payment that already exists rather than charging again.
        const authorized = await provider.authorize({
          amount: this.amountOf(state),
          reference: idempotencyKey,
          description: `Order ${state.orderId}`,
        });

        const settled = await this.captureIfNeeded(provider, authorized);
        return { paymentId: settled.id };
      },
      compensate: async ({ state, idempotencyKey }) => {
        const provider = this.payments.defaultProvider;
        const payment = await this.resolvePayment(provider, state, idempotencyKey);

        if (!payment) return;
        if (payment.status === "refunded") return;
        if (payment.status !== "succeeded" && payment.status !== "partially_refunded") {
          // Authorised and never captured: no money moved, and the hold lapses
          // at the provider. There is deliberately nothing to call — a `void`
          // is not on this port, and inventing one here would be a second,
          // untested code path for the case that costs nobody anything.
          this.logger.log(
            `Payment ${payment.id} for order ${state.orderId} is "${payment.status}"; ` +
              "nothing was captured, so the authorisation is left to lapse.",
          );
          return;
        }

        await provider.refund(payment.id);
      },
    };
  }

  /** The pivot. See {@link import("./ports").ShippingService}. */
  private createShipment(): SagaStep<CheckoutSagaState> {
    return {
      name: "create-shipment",
      kind: "pivot",
      execute: async ({ state, idempotencyKey }) => {
        try {
          const shipment = await this.shipping.createShipment({
            orderId: state.orderId,
            destination: state.shippingCountry,
            lines: state.lines,
            shipmentId: idempotencyKey,
          });
          return { shipmentId: shipment.id };
        } catch (error: unknown) {
          // A country nobody delivers to is not going to become one. This is
          // the failure that takes the saga all the way back through a refund
          // and a release, which is why `orders.e2e-spec.ts` uses it.
          if (error instanceof UnservicedDestinationError) {
            throw new UnretryableStepError(error.message, error);
          }
          throw error;
        }
      },
    };
  }

  /**
   * Past the pivot, so it is `retriable` and never compensated.
   *
   * Its only failure mode is the database, and the correct response to that is
   * to try again until it answers: the money is captured and the parcel is
   * booked, so an order left saying `PROCESSING` is a support ticket rather
   * than a state anyone should design a rollback for. A saga that exhausts its
   * attempts here goes `STUCK`, which is the alert.
   */
  private confirmOrder(): SagaStep<CheckoutSagaState> {
    return {
      name: "confirm-order",
      kind: "retriable",
      execute: async ({ state }) => {
        const { paymentId, shipmentId } = state;
        if (!paymentId || !shipmentId) {
          // Unreachable through the definition — both are set by steps that
          // must have completed for this one to run — so it is a corrupted
          // state rather than a case to handle. Saying so beats a `!`.
          throw new Error(
            `Order ${state.orderId} reached confirm-order without a payment or a shipment.`,
          );
        }

        const order = await this.orders.find(state.orderId);
        if (!order) throw new Error(`Order ${state.orderId} no longer exists.`);
        // A retry after a write that landed but whose acknowledgement did not.
        // Returning here rather than writing again is what keeps
        // `order.confirmed` a single event per order.
        if (order.status === "CONFIRMED") return;

        await this.transactions.run(async (tx) => {
          await this.orders.transition(tx, state.orderId, { status: "CONFIRMED" });
          await this.outbox.stage(tx, "order.confirmed", {
            orderId: state.orderId,
            userId: state.userId,
            paymentId,
            shipmentId,
          });
        });
      },
    };
  }

  private amountOf(state: CheckoutSagaState): Money {
    return { amountMinor: state.totalMinor, currency: state.currency };
  }

  /**
   * Captures an authorisation, tolerating one that is already captured.
   *
   * The second case is a retry of a step whose capture succeeded and whose
   * answer was lost. The provider then refuses the transition — correctly, it
   * is not `authorized` any more — and treating that refusal as a failure would
   * compensate a payment that is exactly where the step wanted it.
   */
  private async captureIfNeeded(provider: PaymentProvider, payment: Payment): Promise<Payment> {
    if (payment.status === "succeeded" || payment.status === "partially_refunded") return payment;

    if (payment.status !== "authorized") {
      // `requires_action` lands here, and that is a real limitation rather than
      // an oversight: a redirect or a 3-D Secure confirmation needs the buyer,
      // and a saga step has nobody to redirect. A checkout on a gateway that
      // requires one needs a step that *waits* for a webhook, which is a
      // different shape than this repository has. Failing permanently at least
      // refunds nothing and releases the stock.
      throw new UnretryableStepError(
        `Payment ${payment.id} is "${payment.status}" and cannot be captured without the buyer.`,
      );
    }

    try {
      return await provider.capture(payment.id);
    } catch (error: unknown) {
      if (!(error instanceof PaymentStateError)) throw error;
      const current = await provider.find(payment.id);
      if (current && (current.status === "succeeded" || current.status === "partially_refunded")) {
        return current;
      }
      throw new UnretryableStepError(
        `Payment ${payment.id} could not be captured: ${error.message}`,
        error,
      );
    }
  }

  /**
   * Finds the payment this step made, even if it never heard that it did.
   *
   * The interesting branch is the second one. If `charge-payment` authorised
   * and then died before its progress was written, `state.paymentId` is null
   * while a real payment exists at the gateway under this step's key — and a
   * compensation that trusted the state would leave it there. `authorize` is
   * idempotent on `reference`, so calling it again is how the reference is
   * turned back into an id; it returns the existing payment rather than making
   * a second one.
   *
   * The cost, stated plainly: if the step failed *before* authorising, this
   * call creates an authorisation purely in order to find nothing. That is a
   * hold on the buyer's card that is never captured and lapses at the
   * provider — the cheapest of the available wrong answers, and the reason to
   * prefer it is that the other one silently keeps money. A gateway with a
   * search-by-reference endpoint would not need the trade at all, and adding
   * one to `PaymentProvider` is the right fix when a real integration lands.
   */
  private async resolvePayment(
    provider: PaymentProvider,
    state: CheckoutSagaState,
    idempotencyKey: string,
  ): Promise<Payment | null> {
    if (state.paymentId) return provider.find(state.paymentId);

    return provider.authorize({
      amount: this.amountOf(state),
      reference: idempotencyKey,
      description: `Order ${state.orderId}`,
    });
  }
}
