import { SagaRegistry } from "@/saga";
import type { SagaInstanceRecord, SagaStatus } from "@/saga";
import type { CheckoutSagaState } from "../checkout.saga";
import type { OrderRecord } from "../order";

/**
 * How the checkout is going, as a customer may see it.
 *
 * It is assembled from the saga instance rather than copied onto the order row,
 * and that is the reason the order table has no `paymentId` column. Two copies
 * of the same fact drift: the saga writes its state on every step, and an order
 * column would only be written by whichever step remembered to. Reading it from
 * the instance means what the customer sees and what the orchestrator will do
 * next cannot disagree.
 */
export interface OrderFulfilment {
  readonly sagaId: string;
  /** Null when the instance is gone — a retention job, or a manual cleanup. */
  readonly status: SagaStatus | null;
  /** The step the saga is at, or stopped at. Null once it is finished or gone. */
  readonly step: string | null;
  readonly reservationId: string | null;
  readonly paymentId: string | null;
  readonly shipmentId: string | null;
}

export interface OrderView {
  readonly order: OrderRecord;
  readonly fulfilment: OrderFulfilment;
}

/**
 * Joins an order to its saga.
 *
 * The step name comes from the registry rather than from the row, because the
 * row stores a *position*: the definition is what turns 2 into
 * `charge-payment`. An instance whose definition this build no longer has
 * reports `null` rather than an index nobody can interpret.
 */
export function toOrderView(
  order: OrderRecord,
  instance: SagaInstanceRecord | null,
  registry: SagaRegistry,
): OrderView {
  if (!instance) {
    return {
      order,
      fulfilment: {
        sagaId: order.sagaId,
        status: null,
        step: null,
        reservationId: null,
        paymentId: null,
        shipmentId: null,
      },
    };
  }

  const state = instance.state as Partial<CheckoutSagaState>;
  const definition = registry.find(instance.name);
  const running = instance.status === "RUNNING" || instance.status === "COMPENSATING";
  const stuck = instance.status === "STUCK";

  return {
    order,
    fulfilment: {
      sagaId: instance.id,
      status: instance.status,
      // A finished saga is not "at" a step, so naming one would invite a client
      // to render "charge-payment" next to a confirmed order.
      step: running || stuck ? (definition?.steps[instance.cursor]?.name ?? null) : null,
      reservationId: state.reservationId ?? null,
      paymentId: state.paymentId ?? null,
      shipmentId: state.shipmentId ?? null,
    },
  };
}
