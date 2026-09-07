import type { TransactionContext } from "@/common/prisma/transaction.port";
import type {
  ListOrdersCriteria,
  NewOrder,
  OrderRecord,
  OrderStore,
  OrderTransition,
} from "@/orders";

/**
 * In-memory implementation of {@link OrderStore}.
 *
 * Lets the unit and e2e suites run whole checkouts — five steps, compensations
 * and all — with no Postgres, the same reason `InMemoryOutboxStore` and
 * `InMemorySagaStore` exist. It honours the one part of the contract a double
 * can: an order staged inside a unit of work that then fails does not exist
 * afterwards, which is what makes the "order and saga commit together" property
 * observable in a spec.
 */
export class InMemoryOrderStore implements OrderStore {
  private readonly rows = new Map<string, OrderRecord>();

  create(tx: TransactionContext, order: NewOrder): Promise<OrderRecord> {
    const now = new Date();
    const record: OrderRecord = {
      id: order.id,
      userId: order.userId,
      items: order.items,
      total: order.total,
      shippingCountry: order.shippingCountry,
      status: "PENDING",
      failureReason: null,
      sagaId: order.sagaId,
      createdAt: now,
      updatedAt: now,
    };
    this.rows.set(record.id, record);
    tx.onRollback(() => {
      this.rows.delete(record.id);
    });
    return Promise.resolve(record);
  }

  transition(
    _tx: TransactionContext,
    id: string,
    transition: OrderTransition,
  ): Promise<OrderRecord> {
    const row = this.rows.get(id);
    // The same disposition the real client gives for `update` against a missing
    // row, so a caller cannot come to depend on a friendlier one here.
    if (!row) return Promise.reject(new Error(`Order ${id} not found`));

    const updated: OrderRecord = {
      ...row,
      status: transition.status,
      failureReason: transition.failureReason ?? null,
      updatedAt: new Date(),
    };
    this.rows.set(id, updated);
    return Promise.resolve(updated);
  }

  find(id: string): Promise<OrderRecord | null> {
    return Promise.resolve(this.rows.get(id) ?? null);
  }

  listForUser(criteria: ListOrdersCriteria): Promise<readonly OrderRecord[]> {
    const all = [...this.rows.values()]
      .filter((row) => row.userId === criteria.userId)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || (a.id < b.id ? 1 : -1));

    let start = 0;
    if (criteria.cursor) {
      const index = all.findIndex((row) => row.id === criteria.cursor);
      if (index >= 0) start = index + 1;
    }
    return Promise.resolve(all.slice(start, start + criteria.limit + 1));
  }

  /** Forgets every order, for a suite that shares one application. */
  reset(): void {
    this.rows.clear();
  }

  /** Every order, for a spec that wants to assert on the whole table. */
  all(): readonly OrderRecord[] {
    return [...this.rows.values()];
  }
}
