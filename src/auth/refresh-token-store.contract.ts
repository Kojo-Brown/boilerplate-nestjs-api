import { Role } from "@prisma/client";
import type { RefreshTokenStore } from "./ports";

/** What a suite must supply to run the contract: a store, and a user to own tokens. */
export interface RefreshTokenStoreHarness {
  readonly store: RefreshTokenStore;
  /** A user that exists as far as this store is concerned. */
  readonly owner: { id: string; email: string; role: Role };
}

const HOUR = 3_600_000;

/**
 * The behavioural contract every refresh-token store must satisfy.
 *
 * Written once and run against both implementations — against Postgres in
 * `test/refresh-token-store.db-spec.ts`, and against the in-memory double in
 * `refresh-token-store.contract.spec.ts`. The signatures already type-check;
 * what the contract pins is the behaviour that differs between a real store and
 * a plausible fake, and in particular the one property `consume` exists for:
 * that concurrent callers cannot both claim the same token.
 *
 * That property is the reason this is a shared contract rather than two test
 * files. Asserted only against Postgres, nothing would stop the double the e2e
 * suite runs the whole application on from letting both callers win; asserted
 * only against the double, it would prove something about promise chains and
 * nothing about SQL.
 */
export function describeRefreshTokenStoreContract(
  name: string,
  createHarness: () => Promise<RefreshTokenStoreHarness>,
): void {
  describe(`${name} (refresh-token store contract)`, () => {
    let harness: RefreshTokenStoreHarness;

    const issue = async (token: string, expiresAt = new Date(Date.now() + HOUR)) => {
      await harness.store.issue({ token, userId: harness.owner.id, expiresAt });
      return token;
    };

    beforeEach(async () => {
      harness = await createHarness();
    });

    describe("consume()", () => {
      it("resolves with null — not undefined — for a token that was never issued", async () => {
        await expect(harness.store.consume("never-issued")).resolves.toBeNull();
      });

      it("resolves with the token's owner", async () => {
        await issue("tok-owner");

        await expect(harness.store.consume("tok-owner")).resolves.toMatchObject({
          userId: harness.owner.id,
          email: harness.owner.email,
          role: harness.owner.role,
        });
      });

      it("returns the token's own expiry, leaving the expiry policy to the caller", async () => {
        const expiresAt = new Date(Date.now() + 2 * HOUR);
        await issue("tok-expiry", expiresAt);

        const consumed = await harness.store.consume("tok-expiry");

        expect(consumed?.expiresAt.getTime()).toBe(expiresAt.getTime());
      });

      it("claims an already-expired token rather than leaving it in the store", async () => {
        // The store decides who gets the row, not whether the row is still
        // acceptable. A store that refused here would leave every rejected
        // token behind for something else to clean up.
        await issue("tok-stale", new Date(Date.now() - HOUR));

        await expect(harness.store.consume("tok-stale")).resolves.not.toBeNull();
        await expect(harness.store.consume("tok-stale")).resolves.toBeNull();
      });

      it("is single-use: the second consume of the same token resolves with null", async () => {
        await issue("tok-once");

        await expect(harness.store.consume("tok-once")).resolves.not.toBeNull();
        await expect(harness.store.consume("tok-once")).resolves.toBeNull();
      });

      it("consuming one token leaves the others alone", async () => {
        await issue("tok-a");
        await issue("tok-b");

        await harness.store.consume("tok-a");

        await expect(harness.store.consume("tok-b")).resolves.not.toBeNull();
      });

      /**
       * The property the whole port exists for.
       *
       * Both calls are started before either is awaited, so they overlap for
       * real. A read-then-delete implementation has both callers find the row
       * and then fails the loser out of its `DELETE` — so it either returns two
       * owners or raises a driver error, and this assertion catches both.
       */
      it("admits exactly one of two concurrent claims on the same token", async () => {
        await issue("tok-contended");

        const results = await Promise.all([
          harness.store.consume("tok-contended"),
          harness.store.consume("tok-contended"),
        ]);

        expect(results.filter((result) => result !== null)).toHaveLength(1);
        expect(results.filter((result) => result === null)).toHaveLength(1);
      });

      it("admits exactly one claim however many callers race for it", async () => {
        await issue("tok-stampede");

        const results = await Promise.all(
          Array.from({ length: 8 }, () => harness.store.consume("tok-stampede")),
        );

        expect(results.filter((result) => result !== null)).toHaveLength(1);
      });

      it("lets concurrent claims on different tokens both succeed", async () => {
        // The lock is per row. A store that serialised every claim globally
        // would also pass the tests above, and would turn every refresh in the
        // system into a queue behind one another.
        await issue("tok-x");
        await issue("tok-y");

        const results = await Promise.all([
          harness.store.consume("tok-x"),
          harness.store.consume("tok-y"),
        ]);

        expect(results.filter((result) => result !== null)).toHaveLength(2);
      });
    });

    describe("revoke()", () => {
      it("makes the token unclaimable", async () => {
        await issue("tok-revoked");

        await harness.store.revoke("tok-revoked");

        await expect(harness.store.consume("tok-revoked")).resolves.toBeNull();
      });

      it("is idempotent and does not reject on an unknown token", async () => {
        await expect(harness.store.revoke("never-issued")).resolves.toBeUndefined();
        await expect(harness.store.revoke("never-issued")).resolves.toBeUndefined();
      });
    });
  });
}
