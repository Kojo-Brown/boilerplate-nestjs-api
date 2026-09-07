import type { TransactionContext } from "@/common/prisma/transaction.port";
import type { NewOrder, OrderRecord, OrderStatus } from "../order";

/** DI token for {@link OrderStore}. */
export const ORDER_STORE = Symbol("ORDER_STORE");

export interface ListOrdersCriteria {
  readonly userId: string;
  /** The page size the client asked for. Implementations fetch `limit + 1`. */
  readonly limit: number;
  /** The decoded cursor — an order id — or absent for the first page. */
  readonly cursor?: string;
}

/** What a status transition records alongside the status itself. */
export interface OrderTransition {
  readonly status: OrderStatus;
  /** Set when cancelling, cleared otherwise. */
  readonly failureReason?: string | null;
}

/**
 * Persistence for orders.
 *
 * {@link create} and {@link transition} both take a transaction and neither
 * opens one, which is unusual for a repository in this codebase and is the
 * point: every write to an order happens alongside something else that must
 * commit with it. Creation commits with the saga instance that will drive the
 * order and with the `order.placed` event that announces it; a transition
 * commits with the event that reports it. An order that changed status without
 * its event, or with an event describing a status the row never reached, is
 * exactly what the outbox exists to make impossible.
 */
export interface OrderStore {
  create(tx: TransactionContext, order: NewOrder): Promise<OrderRecord>;

  /**
   * Moves an order to a new status inside the caller's transaction.
   *
   * Resolves with the updated record. Rejects for an order that is not there,
   * which in a saga step means the row was deleted underneath a running saga —
   * a real failure rather than something to swallow.
   */
  transition(tx: TransactionContext, id: string, transition: OrderTransition): Promise<OrderRecord>;

  find(id: string): Promise<OrderRecord | null>;

  /**
   * One page of a customer's orders, newest first.
   *
   * Returns up to `limit + 1` rows, which is the convention `buildCursorPage`
   * expects: the extra row is how the caller knows there is a next page without
   * a second count query.
   */
  listForUser(criteria: ListOrdersCriteria): Promise<readonly OrderRecord[]>;
}
