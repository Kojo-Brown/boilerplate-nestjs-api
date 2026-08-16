import { Role } from "@prisma/client";
import type { PrismaClient } from "@prisma/client";
import { PrismaRefreshTokenStore } from "@/auth/prisma-refresh-token.store";
import { describeRefreshTokenStoreContract } from "@/auth/refresh-token-store.contract";
import { asPrismaService, createClient, truncateAll, uniqueEmail } from "./helpers/db";

/**
 * `PrismaRefreshTokenStore` against a real Postgres.
 *
 * The same contract runs against the in-memory double in
 * `src/auth/refresh-token-store.contract.spec.ts`. This is the half that
 * matters for pessimistic locking: the exclusion the contract asserts *is*
 * `SELECT … FOR UPDATE`, and there is no fake `PrismaService` that could stand
 * in for it — reproducing the property in a double would mean reimplementing
 * the thing under test.
 */
describe("PrismaRefreshTokenStore (Postgres)", () => {
  let client: PrismaClient;

  beforeAll(() => {
    client = createClient();
  });

  afterAll(async () => {
    await truncateAll(client);
    await client.$disconnect();
  });

  describeRefreshTokenStoreContract("PrismaRefreshTokenStore", async () => {
    await truncateAll(client);
    const owner = await client.user.create({
      data: { email: uniqueEmail("refresh-contract"), role: Role.USER },
    });
    return { store: new PrismaRefreshTokenStore(asPrismaService(client)), owner };
  });

  describe("rotation under real contention", () => {
    let other: PrismaClient;

    beforeAll(() => {
      // A second connection, so the two transactions are genuinely concurrent
      // rather than serialised by sharing one.
      other = createClient();
    });

    afterAll(async () => {
      await other.$disconnect();
    });

    beforeEach(async () => {
      await truncateAll(client);
    });

    it("admits one of two claims raced across two connections", async () => {
      const owner = await client.user.create({ data: { email: uniqueEmail("race") } });
      const store = new PrismaRefreshTokenStore(asPrismaService(client));
      const rival = new PrismaRefreshTokenStore(asPrismaService(other));
      await store.issue({
        token: "raced-token",
        userId: owner.id,
        expiresAt: new Date(Date.now() + 3_600_000),
      });

      const results = await Promise.all([
        store.consume("raced-token"),
        rival.consume("raced-token"),
      ]);

      expect(results.filter((result) => result !== null)).toHaveLength(1);
      // And the row is gone exactly once — the loser must not have deleted a
      // row that was already deleted, which is what the old read-then-delete
      // did before failing with P2025.
      await expect(client.refreshToken.count({ where: { token: "raced-token" } })).resolves.toBe(0);
    });

    it("leaves no token behind when the transaction rolls back", async () => {
      // The delete and the claim are the same transaction, so a failure after
      // the delete must not spend the token. Simulated by rolling the
      // transaction back from inside.
      const owner = await client.user.create({ data: { email: uniqueEmail("rollback") } });
      const store = new PrismaRefreshTokenStore(asPrismaService(client));
      await store.issue({
        token: "rollback-token",
        userId: owner.id,
        expiresAt: new Date(Date.now() + 3_600_000),
      });

      await expect(
        client.$transaction(async (tx) => {
          await tx.refreshToken.delete({ where: { token: "rollback-token" } });
          throw new Error("something failed after the delete");
        }),
      ).rejects.toThrow("something failed after the delete");

      await expect(store.consume("rollback-token")).resolves.not.toBeNull();
    });

    it("does not serialise claims on different tokens", async () => {
      const owner = await client.user.create({ data: { email: uniqueEmail("parallel") } });
      const store = new PrismaRefreshTokenStore(asPrismaService(client));
      const rival = new PrismaRefreshTokenStore(asPrismaService(other));
      const expiresAt = new Date(Date.now() + 3_600_000);
      await store.issue({ token: "tok-p1", userId: owner.id, expiresAt });
      await store.issue({ token: "tok-p2", userId: owner.id, expiresAt });

      const results = await Promise.all([store.consume("tok-p1"), rival.consume("tok-p2")]);

      expect(results.filter((result) => result !== null)).toHaveLength(2);
    });

    it("cascades: deleting the user makes their tokens unclaimable", async () => {
      const owner = await client.user.create({ data: { email: uniqueEmail("cascade") } });
      const store = new PrismaRefreshTokenStore(asPrismaService(client));
      await store.issue({
        token: "orphan-token",
        userId: owner.id,
        expiresAt: new Date(Date.now() + 3_600_000),
      });

      await client.user.delete({ where: { id: owner.id } });

      await expect(store.consume("orphan-token")).resolves.toBeNull();
    });
  });
});
