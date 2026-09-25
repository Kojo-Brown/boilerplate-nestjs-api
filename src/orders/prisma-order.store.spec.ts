import { Logger } from "@nestjs/common";
import type { PrismaService } from "@/common/prisma/prisma.service";
import type { FieldEncryptionService } from "@/crypto/field-encryption.service";
import { ORDER_ITEMS_FIELD, PrismaOrderStore } from "./prisma-order.store";

/**
 * Only the bootstrap hook is asserted here. Everything else this class does is
 * SQL, and `test/order-store.db-spec.ts` runs it against a real Postgres for the
 * reason that file gives — a double would be asserting that our idea of Prisma
 * behaves the way we imagined.
 *
 * This part is the exception because it is not SQL at all: it is a decision
 * about what a key manager being unreachable at startup should do to a rollout,
 * and that decision is invisible in a db-spec.
 */
describe("PrismaOrderStore bootstrap", () => {
  const prisma = {} as PrismaService;

  it("mints the column's data key before the first checkout can need it", async () => {
    // A KMS round trip inside the transaction `PlaceOrderHandler` opens would
    // hold a Postgres connection for the length of somebody else's network call.
    const prepare = jest.fn<Promise<void>, [unknown]>().mockResolvedValue(undefined);
    const store = new PrismaOrderStore(prisma, { prepare } as unknown as FieldEncryptionService);

    await store.onApplicationBootstrap();

    expect(prepare).toHaveBeenCalledWith(ORDER_ITEMS_FIELD);
  });

  it("logs and continues when the key manager cannot be reached", async () => {
    // Deliberately not a failed boot. Refusing to start would turn a KMS blip
    // into a failed rollout for every endpoint in the service, including the
    // ones that encrypt nothing — and the first checkout after it raises the
    // real error anyway, at the moment it actually matters.
    const error = jest.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
    const prepare = jest.fn().mockRejectedValue(new Error("KMS is unreachable"));
    const store = new PrismaOrderStore(prisma, { prepare } as unknown as FieldEncryptionService);

    await expect(store.onApplicationBootstrap()).resolves.toBeUndefined();

    expect(error).toHaveBeenCalledWith(expect.stringContaining("KMS is unreachable"));
    expect(error).toHaveBeenCalledWith(expect.stringContaining("orders.itemsCiphertext"));
    error.mockRestore();
  });
});
