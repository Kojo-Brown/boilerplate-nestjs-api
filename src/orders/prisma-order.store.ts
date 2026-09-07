import { Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import type { Order } from "@prisma/client";
import { PrismaService } from "@/common/prisma/prisma.service";
import { requirePrismaTransaction } from "@/common/prisma/prisma-transaction.runner";
import type { TransactionContext } from "@/common/prisma/transaction.port";
import type { NewOrder, OrderItem, OrderRecord } from "./order";
import type { ListOrdersCriteria, OrderStore, OrderTransition } from "./ports";

/**
 * The Postgres-backed order store.
 *
 * Plain Prisma throughout — there is no claim, no lease and no `SKIP LOCKED`
 * here, because an order is only ever written by the saga that owns it and the
 * saga's own row is what two runners contend for. That contention is settled in
 * `PrismaSagaStore`, once, rather than again in every participant.
 */
@Injectable()
export class PrismaOrderStore implements OrderStore {
  constructor(private readonly prisma: PrismaService) {}

  async create(tx: TransactionContext, order: NewOrder): Promise<OrderRecord> {
    const client = requirePrismaTransaction(tx, PrismaOrderStore.name);
    const row = await client.order.create({
      data: {
        id: order.id,
        userId: order.userId,
        items: order.items as unknown as Prisma.InputJsonArray,
        totalMinor: order.total.amountMinor,
        currency: order.total.currency,
        shippingCountry: order.shippingCountry,
        sagaId: order.sagaId,
      },
    });
    return toRecord(row);
  }

  async transition(
    tx: TransactionContext,
    id: string,
    transition: OrderTransition,
  ): Promise<OrderRecord> {
    const client = requirePrismaTransaction(tx, PrismaOrderStore.name);
    const row = await client.order.update({
      where: { id },
      data: {
        status: transition.status,
        // Explicit rather than conditional: a transition that does not mention
        // a reason is clearing one. Otherwise an order cancelled, retried and
        // then confirmed would keep the failure text of the attempt that did
        // not happen.
        failureReason: transition.failureReason ?? null,
      },
    });
    return toRecord(row);
  }

  async find(id: string): Promise<OrderRecord | null> {
    const row = await this.prisma.order.findUnique({ where: { id } });
    return row ? toRecord(row) : null;
  }

  async listForUser(criteria: ListOrdersCriteria): Promise<readonly OrderRecord[]> {
    const rows = await this.prisma.order.findMany({
      where: { userId: criteria.userId },
      // Newest first, and `id` breaks the tie — two orders placed in the same
      // millisecond would otherwise have no stable order, and a cursor over an
      // unstable order skips and repeats rows.
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      // `limit + 1`: the extra row is what tells `buildCursorPage` there is a
      // next page, without a second query that counts.
      take: criteria.limit + 1,
      cursor: criteria.cursor ? { id: criteria.cursor } : undefined,
      skip: criteria.cursor ? 1 : 0,
    });
    return rows.map(toRecord);
  }
}

function toRecord(row: Order): OrderRecord {
  return {
    id: row.id,
    userId: row.userId,
    // `items` is `jsonb`, so the database guarantees it is JSON and nothing
    // about its shape. It was written by `create` from a validated DTO in this
    // same service, which is the argument for reading it back without a second
    // schema — the same one `PrismaOutboxStore` makes about payloads, with the
    // same limit: a row written by an older build whose shape has since changed
    // is not covered.
    items: Array.isArray(row.items) ? (row.items as unknown as OrderItem[]) : [],
    total: { amountMinor: row.totalMinor, currency: row.currency },
    shippingCountry: row.shippingCountry,
    status: row.status,
    failureReason: row.failureReason,
    sagaId: row.sagaId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
