import { Injectable, Logger } from "@nestjs/common";
import type { OnApplicationBootstrap } from "@nestjs/common";
import type { Order } from "@prisma/client";
import { PrismaService } from "@/common/prisma/prisma.service";
import { requirePrismaTransaction } from "@/common/prisma/prisma-transaction.runner";
import type { TransactionContext } from "@/common/prisma/transaction.port";
import { encryptedField, fieldName, FieldEncryptionService } from "@/crypto";
import type { NewOrder, OrderItem, OrderRecord } from "./order";
import type { ListOrdersCriteria, OrderStore, OrderTransition } from "./ports";

/**
 * The encrypted column, declared once.
 *
 * The table and column names are bound into the authenticated data of every
 * value written here, so the writer and every reader have to agree on them byte
 * for byte — which is an argument for one exported constant rather than two
 * string literals per call site. See `src/crypto/encrypted-field.ts`.
 */
export const ORDER_ITEMS_FIELD = encryptedField("orders", "itemsCiphertext");

/**
 * The Postgres-backed order store.
 *
 * Plain Prisma throughout — there is no claim, no lease and no `SKIP LOCKED`
 * here, because an order is only ever written by the saga that owns it and the
 * saga's own row is what two runners contend for. That contention is settled in
 * `PrismaSagaStore`, once, rather than again in every participant.
 *
 * It is also where the order lines are encrypted and decrypted, and a repository
 * is the right layer for that for one concrete reason: field encryption binds
 * each value to the id of the row it sits on, and this is the layer that knows
 * the id. Pushing it up into the command handler would mean passing an id
 * alongside a value that already belongs to a row; pushing it down into a Prisma
 * client extension would mean doing it where the id, on a `create` with a
 * generated key, does not exist yet. Neither `OrderStore` nor any caller can tell
 * the difference: `NewOrder.items` and `OrderRecord.items` are still the lines.
 */
@Injectable()
export class PrismaOrderStore implements OrderStore, OnApplicationBootstrap {
  private readonly logger = new Logger(PrismaOrderStore.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly cipher: FieldEncryptionService,
  ) {}

  /**
   * Mints this column's data key at startup rather than during the first
   * checkout.
   *
   * Every write here happens inside a transaction the caller opened — that is the
   * whole point of `OrderStore`'s signature — and a KMS round trip inside a
   * transaction holds a Postgres connection open for the length of somebody
   * else's network call, which is exactly what `PlaceOrderHandler` is careful not
   * to do with a payment gateway. The materials cache replaces the key ahead of
   * its expiry for the same reason; this covers the one call that has no key to
   * refresh yet.
   *
   * A failure is logged and swallowed rather than allowed to fail the boot. The
   * alternative makes a KMS blip a failed rollout for every endpoint in the
   * service, including the ones that encrypt nothing — and the first checkout
   * after it would raise the real error anyway, at the moment it actually
   * matters.
   */
  async onApplicationBootstrap(): Promise<void> {
    try {
      await this.cipher.prepare(ORDER_ITEMS_FIELD);
    } catch (caught: unknown) {
      const message = caught instanceof Error ? caught.message : String(caught);
      this.logger.error(
        `Could not prepare the data key for ${fieldName(ORDER_ITEMS_FIELD)} at startup: ` +
          `${message}. The first checkout will try again and will report the real failure.`,
      );
    }
  }

  async create(tx: TransactionContext, order: NewOrder): Promise<OrderRecord> {
    const client = requirePrismaTransaction(tx, PrismaOrderStore.name);
    const row = await client.order.create({
      data: {
        id: order.id,
        userId: order.userId,
        // Encrypted against the id the caller minted, not against one the
        // database is about to assign: the id is in the authenticated data, so
        // it has to be the id the row will really have. `PlaceOrderHandler`
        // already mints it, because the saga's state carries it.
        // `new Uint8Array(…)` because Prisma types a `Bytes` column as
        // `Uint8Array<ArrayBuffer>` and a Node `Buffer` is
        // `Uint8Array<ArrayBufferLike>` — the two differ only in whether the
        // backing store may be shared, which a copy settles. The crypto module
        // speaks `Buffer` because everything in `node:crypto` does.
        itemsCiphertext: new Uint8Array(
          await this.cipher.encryptJson(ORDER_ITEMS_FIELD, order.id, order.items),
        ),
        totalMinor: order.total.amountMinor,
        currency: order.total.currency,
        shippingCountry: order.shippingCountry,
        sagaId: order.sagaId,
      },
    });
    return this.toRecord(row);
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
    return this.toRecord(row);
  }

  async find(id: string): Promise<OrderRecord | null> {
    const row = await this.prisma.order.findUnique({ where: { id } });
    return row ? this.toRecord(row) : null;
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

    // One `Promise.all` rather than a loop with an `await` in it: every row on a
    // page was almost certainly written under the same data key, and the cache
    // coalesces concurrent unwraps of one wrapped key into a single KMS call.
    // Awaiting row by row would serialise a page behind as many round trips as
    // there are distinct keys on it — the N+1 `docs/dataloader.md` is about,
    // with a KMS bill attached.
    return Promise.all(rows.map((row) => this.toRecord(row)));
  }

  /**
   * Turns a row into a record, decrypting the lines.
   *
   * The shape check survives the move to ciphertext and is still worth making:
   * the bytes authenticated, which proves this service wrote them for this row,
   * and proves nothing at all about the shape a build from six months ago wrote
   * them in. That is the same argument the `jsonb` version of this function made,
   * with the same limit — a row written by an older build whose `OrderItem` has
   * since changed is not covered.
   */
  private async toRecord(row: Order): Promise<OrderRecord> {
    const items = await this.cipher.decryptJson(
      ORDER_ITEMS_FIELD,
      row.id,
      Buffer.from(row.itemsCiphertext),
    );

    return {
      id: row.id,
      userId: row.userId,
      items: Array.isArray(items) ? (items as OrderItem[]) : [],
      total: { amountMinor: row.totalMinor, currency: row.currency },
      shippingCountry: row.shippingCountry,
      status: row.status,
      failureReason: row.failureReason,
      sagaId: row.sagaId,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }
}
