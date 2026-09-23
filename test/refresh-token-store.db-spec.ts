import { Role } from "@prisma/client";
import type { PrismaClient } from "@prisma/client";
import type { RefreshTokenClaim } from "@/auth/ports";
import { PrismaRefreshTokenStore } from "@/auth/prisma-refresh-token.store";
import { describeRefreshTokenStoreContract } from "@/auth/refresh-token-store.contract";
import { asPrismaService, createClient, truncateAll, uniqueEmail } from "./helpers/db";

/**
 * `PrismaRefreshTokenStore` against a real Postgres.
 *
 * The same contract runs against the in-memory double in
 * `src/auth/refresh-token-store.contract.spec.ts`. This is the half that
 * matters for pessimistic locking: the exclusion the contract asserts *is*
 * `SELECT … FOR NO KEY UPDATE`, and there is no fake `PrismaService` that could
 * stand in for it — reproducing the property in a double would mean
 * reimplementing the thing under test.
 *
 * The suites below it are the cases a single client cannot reach at all: two
 * connections racing a replay, and the rows the detection is actually made of.
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

      expect(results.filter((result) => result.outcome === "claimed")).toHaveLength(1);
      // And the loser is recognised, not waved off: the row is still there,
      // marked spent exactly once, and the family it belonged to is revoked.
      expect(results.filter((result) => result.outcome === "reused")).toHaveLength(1);
      const row = await client.refreshToken.findUnique({
        where: { token: "raced-token" },
        include: { family: true },
      });
      expect(row?.consumedAt).toBeInstanceOf(Date);
      expect(row?.family.revokedReason).toBe("REUSE_DETECTED");
    });

    it("leaves no token behind when the transaction rolls back", async () => {
      // The `consumedAt` write and the claim are the same transaction, so a
      // failure after the write must not spend the token. Simulated by rolling
      // the transaction back from inside.
      const owner = await client.user.create({ data: { email: uniqueEmail("rollback") } });
      const store = new PrismaRefreshTokenStore(asPrismaService(client));
      await store.issue({
        token: "rollback-token",
        userId: owner.id,
        expiresAt: new Date(Date.now() + 3_600_000),
      });

      await expect(
        client.$transaction(async (tx) => {
          await tx.refreshToken.update({
            where: { token: "rollback-token" },
            data: { consumedAt: new Date() },
          });
          throw new Error("something failed after the delete");
        }),
      ).rejects.toThrow("something failed after the delete");

      await expect(store.consume("rollback-token")).resolves.toMatchObject({
        outcome: "claimed",
      });
    });

    it("does not serialise claims on different tokens", async () => {
      const owner = await client.user.create({ data: { email: uniqueEmail("parallel") } });
      const store = new PrismaRefreshTokenStore(asPrismaService(client));
      const rival = new PrismaRefreshTokenStore(asPrismaService(other));
      const expiresAt = new Date(Date.now() + 3_600_000);
      await store.issue({ token: "tok-p1", userId: owner.id, expiresAt });
      await store.issue({ token: "tok-p2", userId: owner.id, expiresAt });

      const results = await Promise.all([store.consume("tok-p1"), rival.consume("tok-p2")]);

      expect(results.filter((result) => result.outcome === "claimed")).toHaveLength(2);
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

      await expect(store.consume("orphan-token")).resolves.toEqual({ outcome: "unknown" });
    });

    it("reports one detection when two connections replay one family at once", async () => {
      // The case the family lock exists for, and the one a single client
      // cannot produce: two *different* spent tokens of the same family,
      // presented simultaneously from two connections. Without the lock both
      // read a live family, both revoke it, and one compromise pages an
      // operator twice.
      const owner = await client.user.create({ data: { email: uniqueEmail("double-replay") } });
      const store = new PrismaRefreshTokenStore(asPrismaService(client));
      const rival = new PrismaRefreshTokenStore(asPrismaService(other));
      const expiresAt = new Date(Date.now() + 3_600_000);

      await store.issue({ token: "gen-1", userId: owner.id, expiresAt });
      const first = await store.consume("gen-1");
      if (first.outcome !== "claimed") throw new Error(`expected a claim, got ${first.outcome}`);
      await store.issue({
        token: "gen-2",
        userId: owner.id,
        familyId: first.token.familyId,
        expiresAt,
      });
      const second = await store.consume("gen-2");
      if (second.outcome !== "claimed") throw new Error(`expected a claim, got ${second.outcome}`);
      await store.issue({
        token: "gen-3",
        userId: owner.id,
        familyId: second.token.familyId,
        expiresAt,
      });

      const results: RefreshTokenClaim[] = await Promise.all([
        store.consume("gen-1"),
        rival.consume("gen-2"),
      ]);

      expect(results.filter((result) => result.outcome === "reused")).toHaveLength(1);
      expect(results.filter((result) => result.outcome === "revoked")).toHaveLength(1);
      await expect(
        client.refreshTokenFamily.count({
          where: { id: first.token.familyId, revokedReason: "REUSE_DETECTED" },
        }),
      ).resolves.toBe(1);
    });

    it("keeps the spent token rather than deleting it", async () => {
      // The whole detection rests on this row surviving. If rotation deleted
      // it, a replay would read as `unknown` — the same answer a typo gets.
      const owner = await client.user.create({ data: { email: uniqueEmail("kept") } });
      const store = new PrismaRefreshTokenStore(asPrismaService(client));
      await store.issue({
        token: "kept-token",
        userId: owner.id,
        expiresAt: new Date(Date.now() + 3_600_000),
      });

      await store.consume("kept-token");

      const row = await client.refreshToken.findUnique({ where: { token: "kept-token" } });
      expect(row?.consumedAt).toBeInstanceOf(Date);
    });

    it("records why each family was revoked", async () => {
      // The reason column is what an operator reads to tell a sign-out apart
      // from an attack, and the two arrive through different code paths.
      const owner = await client.user.create({ data: { email: uniqueEmail("reasons") } });
      const store = new PrismaRefreshTokenStore(asPrismaService(client));
      const expiresAt = new Date(Date.now() + 3_600_000);
      await store.issue({ token: "signed-out", userId: owner.id, expiresAt });
      await store.issue({ token: "replayed", userId: owner.id, expiresAt });

      await store.revoke("signed-out");
      await store.consume("replayed");
      await store.consume("replayed");

      const families = await client.refreshTokenFamily.findMany({
        where: { userId: owner.id },
        include: { tokens: { select: { token: true } } },
        orderBy: { createdAt: "asc" },
      });
      expect(
        Object.fromEntries(
          families.map((family) => [family.tokens[0]?.token, family.revokedReason]),
        ),
      ).toEqual({ "signed-out": "LOGOUT", replayed: "REUSE_DETECTED" });
    });

    it("deletes a pruned family's tokens with it", async () => {
      // Through the foreign key's cascade, so the two can never disagree about
      // whether a family is gone.
      const owner = await client.user.create({ data: { email: uniqueEmail("pruned") } });
      const store = new PrismaRefreshTokenStore(asPrismaService(client));
      await store.issue({
        token: "stale-token",
        userId: owner.id,
        expiresAt: new Date(Date.now() - 3_600_000),
      });

      await expect(store.prune(new Date())).resolves.toBe(1);

      await expect(client.refreshToken.count({ where: { token: "stale-token" } })).resolves.toBe(0);
      await expect(client.refreshTokenFamily.count({ where: { userId: owner.id } })).resolves.toBe(
        0,
      );
    });
  });
});
