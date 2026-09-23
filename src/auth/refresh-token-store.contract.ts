import { Role } from "@prisma/client";
import type { RefreshTokenClaim, RefreshTokenStore } from "./ports";

/** What a suite must supply to run the contract: a store, and a user to own tokens. */
export interface RefreshTokenStoreHarness {
  readonly store: RefreshTokenStore;
  /** A user that exists as far as this store is concerned. */
  readonly owner: { id: string; email: string; role: Role };
}

const HOUR = 3_600_000;

/** Narrowing helper, so a failed expectation names the outcome it got. */
function expectClaimed(claim: RefreshTokenClaim) {
  expect(claim.outcome).toBe("claimed");
  if (claim.outcome !== "claimed") throw new Error("unreachable");
  return claim.token;
}

function expectReused(claim: RefreshTokenClaim) {
  expect(claim.outcome).toBe("reused");
  if (claim.outcome !== "reused") throw new Error("unreachable");
  return claim.reuse;
}

/**
 * The behavioural contract every refresh-token store must satisfy.
 *
 * Written once and run against both implementations — against Postgres in
 * `test/refresh-token-store.db-spec.ts`, and against the in-memory double in
 * `refresh-token-store.contract.spec.ts`. The signatures already type-check;
 * what the contract pins is the behaviour that differs between a real store and
 * a plausible fake, and in particular the two properties `consume` exists for:
 * that concurrent callers cannot both claim the same token, and that the one
 * who loses is recognised as a *replay* rather than waved off as a stranger.
 *
 * Those properties are the reason this is a shared contract rather than two
 * test files. Asserted only against Postgres, nothing would stop the double the
 * e2e suite runs the whole application on from letting both callers win;
 * asserted only against the double, they would prove something about promise
 * chains and nothing about SQL.
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

    /** Issues `token`, then rotates it once. Resolves with the successor's name. */
    const rotate = async (token: string, successor: string) => {
      await issue(token);
      const claimed = expectClaimed(await harness.store.consume(token));
      await harness.store.issue({
        token: successor,
        userId: harness.owner.id,
        familyId: claimed.familyId,
        expiresAt: new Date(Date.now() + HOUR),
      });
      return claimed.familyId;
    };

    beforeEach(async () => {
      harness = await createHarness();
    });

    describe("consume()", () => {
      it("reports a token that was never issued as unknown", async () => {
        await expect(harness.store.consume("never-issued")).resolves.toEqual({
          outcome: "unknown",
        });
      });

      it("resolves with the token's owner", async () => {
        await issue("tok-owner");

        expect(expectClaimed(await harness.store.consume("tok-owner"))).toMatchObject({
          userId: harness.owner.id,
          email: harness.owner.email,
          role: harness.owner.role,
        });
      });

      it("returns the family the successor must be issued into", async () => {
        await issue("tok-family");

        const claimed = expectClaimed(await harness.store.consume("tok-family"));

        expect(typeof claimed.familyId).toBe("string");
        expect(claimed.familyId.length).toBeGreaterThan(0);
      });

      it("gives each fresh sign-in a family of its own", async () => {
        // Two sign-ins are two sessions. Sharing a family would make a replay
        // on one device sign the account out everywhere, which is a far larger
        // blast radius than the compromise justifies.
        await issue("tok-session-a");
        await issue("tok-session-b");

        const a = expectClaimed(await harness.store.consume("tok-session-a"));
        const b = expectClaimed(await harness.store.consume("tok-session-b"));

        expect(a.familyId).not.toBe(b.familyId);
      });

      it("keeps a rotated token in the family it came from", async () => {
        const familyId = await rotate("tok-gen-1", "tok-gen-2");

        expect(expectClaimed(await harness.store.consume("tok-gen-2")).familyId).toBe(familyId);
      });

      it("returns the token's own expiry, leaving the expiry policy to the caller", async () => {
        const expiresAt = new Date(Date.now() + 2 * HOUR);
        await issue("tok-expiry", expiresAt);

        const claimed = expectClaimed(await harness.store.consume("tok-expiry"));

        expect(claimed.expiresAt.getTime()).toBe(expiresAt.getTime());
      });

      it("claims an already-expired token rather than leaving it claimable", async () => {
        // The store decides who gets the row, not whether the row is still
        // acceptable. A store that refused here would leave every rejected
        // token claimable, which is a second chance nobody wanted to give.
        await issue("tok-stale", new Date(Date.now() - HOUR));

        expectClaimed(await harness.store.consume("tok-stale"));
        expect((await harness.store.consume("tok-stale")).outcome).toBe("reused");
      });

      it("is single-use: the second consume of the same token does not claim it", async () => {
        await issue("tok-once");

        expectClaimed(await harness.store.consume("tok-once"));
        expect((await harness.store.consume("tok-once")).outcome).not.toBe("claimed");
      });

      it("consuming one token leaves the others alone", async () => {
        await issue("tok-a");
        await issue("tok-b");

        await harness.store.consume("tok-a");

        expectClaimed(await harness.store.consume("tok-b"));
      });

      /**
       * The property the whole port exists for.
       *
       * Both calls are started before either is awaited, so they overlap for
       * real. A read-then-write implementation has both callers find the row
       * unspent and then lets whichever write lands second decide — so it
       * either claims twice or raises a driver error, and this assertion
       * catches both.
       */
      it("admits exactly one of two concurrent claims on the same token", async () => {
        await issue("tok-contended");

        const results = await Promise.all([
          harness.store.consume("tok-contended"),
          harness.store.consume("tok-contended"),
        ]);

        expect(results.filter((result) => result.outcome === "claimed")).toHaveLength(1);
        // And the loser is told what actually happened. Two requests holding
        // one token is the definition of the event this detects; that one of
        // them is probably an honest retry is a judgement no store can make.
        expect(results.filter((result) => result.outcome === "reused")).toHaveLength(1);
      });

      it("admits exactly one claim however many callers race for it", async () => {
        await issue("tok-stampede");

        const results = await Promise.all(
          Array.from({ length: 8 }, () => harness.store.consume("tok-stampede")),
        );

        expect(results.filter((result) => result.outcome === "claimed")).toHaveLength(1);
        // Seven losers, one detection: the rest arrive at a family that is
        // already revoked and are told so. A store that reported seven would
        // page an operator seven times for one compromise.
        expect(results.filter((result) => result.outcome === "reused")).toHaveLength(1);
        expect(results.filter((result) => result.outcome === "revoked")).toHaveLength(6);
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

        expect(results.filter((result) => result.outcome === "claimed")).toHaveLength(2);
      });
    });

    describe("reuse detection", () => {
      it("reports a replayed token as reuse, naming the family and the owner", async () => {
        const familyId = await rotate("tok-replayed", "tok-successor");

        const reuse = expectReused(await harness.store.consume("tok-replayed"));

        expect(reuse).toEqual({ familyId, userId: harness.owner.id, revokedTokens: 1 });
      });

      it("revokes the live successor the legitimate client is holding", async () => {
        // The cost of the trade, asserted rather than described: the honest
        // client loses its session too, because nothing distinguishes it from
        // the party that replayed the old token.
        await rotate("tok-cut-1", "tok-cut-2");

        await harness.store.consume("tok-cut-1");

        expect((await harness.store.consume("tok-cut-2")).outcome).toBe("revoked");
      });

      it("revokes every generation, not just the newest", async () => {
        await rotate("tok-chain-1", "tok-chain-2");
        const claimed = expectClaimed(await harness.store.consume("tok-chain-2"));
        await harness.store.issue({
          token: "tok-chain-3",
          userId: harness.owner.id,
          familyId: claimed.familyId,
          expiresAt: new Date(Date.now() + HOUR),
        });

        // The oldest token in the chain is replayed.
        expectReused(await harness.store.consume("tok-chain-1"));

        expect((await harness.store.consume("tok-chain-3")).outcome).toBe("revoked");
      });

      it("reports the detection once and calls every later presentation revoked", async () => {
        // A detection is an event, not a state. A store that reported `reused`
        // every time would write one alert per request an attacker chose to
        // send, which is a denial of service against the operator.
        await rotate("tok-twice-1", "tok-twice-2");

        expectReused(await harness.store.consume("tok-twice-1"));

        expect((await harness.store.consume("tok-twice-1")).outcome).toBe("revoked");
        expect((await harness.store.consume("tok-twice-1")).outcome).toBe("revoked");
      });

      it("counts an unrotated family's replay as costing nothing", async () => {
        // Nothing was outstanding: the token was spent and never replaced, so
        // the revocation took no live credential away. Worth telling apart
        // from the case above in the record.
        await issue("tok-dead-end");
        await harness.store.consume("tok-dead-end");

        expect(expectReused(await harness.store.consume("tok-dead-end")).revokedTokens).toBe(0);
      });

      it("leaves the account's other sessions alone", async () => {
        // One compromised session is not grounds for signing the account out
        // of every device it has ever used. The blast radius is the family.
        await rotate("tok-other-1", "tok-other-2");
        await issue("tok-unrelated");

        await harness.store.consume("tok-other-1");

        expectClaimed(await harness.store.consume("tok-unrelated"));
      });

      it("does not report a live token in a revoked family as a fresh detection", async () => {
        await rotate("tok-live-1", "tok-live-2");
        await harness.store.consume("tok-live-1");

        // `tok-live-2` was never spent; it is simply in a family that is over.
        expect((await harness.store.consume("tok-live-2")).outcome).toBe("revoked");
      });
    });

    describe("revoke()", () => {
      it("makes the token unclaimable", async () => {
        await issue("tok-revoked");

        await harness.store.revoke("tok-revoked");

        expect((await harness.store.consume("tok-revoked")).outcome).toBe("revoked");
      });

      it("ends the whole session, not just the token presented", async () => {
        // Signing out means the chain is finished with. Revoking only the
        // presented token would leave its predecessors replayable for as long
        // as the family lived.
        await rotate("tok-out-1", "tok-out-2");

        await harness.store.revoke("tok-out-2");

        expect((await harness.store.consume("tok-out-2")).outcome).toBe("revoked");
        expect((await harness.store.consume("tok-out-1")).outcome).toBe("revoked");
      });

      it("leaves the account's other sessions signed in", async () => {
        await issue("tok-signed-out");
        await issue("tok-still-in");

        await harness.store.revoke("tok-signed-out");

        expectClaimed(await harness.store.consume("tok-still-in"));
      });

      it("is idempotent and does not reject on an unknown token", async () => {
        await expect(harness.store.revoke("never-issued")).resolves.toBeUndefined();
        await expect(harness.store.revoke("never-issued")).resolves.toBeUndefined();
      });

      it("does not turn a token replayed after sign-out into a fresh detection", async () => {
        // The family is already over. Reporting a detection here would mean an
        // alert for every stale token a signed-out client happens to retry.
        await rotate("tok-late-1", "tok-late-2");
        await harness.store.revoke("tok-late-2");

        expect((await harness.store.consume("tok-late-1")).outcome).toBe("revoked");
      });
    });

    describe("prune()", () => {
      it("removes a family whose tokens have all expired", async () => {
        await issue("tok-old", new Date(Date.now() - HOUR));

        await expect(harness.store.prune(new Date())).resolves.toBe(1);

        expect((await harness.store.consume("tok-old")).outcome).toBe("unknown");
      });

      it("keeps a family with one live token, however many spent ones it has", async () => {
        // A family is prunable exactly when nothing in it can still be
        // presented. Pruning the spent generations of a live chain would take
        // away the only evidence a replay of them is a replay.
        await rotate("tok-keep-1", "tok-keep-2");

        await expect(harness.store.prune(new Date())).resolves.toBe(0);

        expectReused(await harness.store.consume("tok-keep-1"));
      });

      it("keeps a family that expires after the cut-off", async () => {
        await issue("tok-young", new Date(Date.now() + HOUR));

        await expect(harness.store.prune(new Date(Date.now() - HOUR))).resolves.toBe(0);

        expectClaimed(await harness.store.consume("tok-young"));
      });

      it("is idempotent", async () => {
        await issue("tok-gone", new Date(Date.now() - HOUR));

        await expect(harness.store.prune(new Date())).resolves.toBe(1);
        await expect(harness.store.prune(new Date())).resolves.toBe(0);
      });

      it("prunes a revoked family once its tokens have expired, and not before", async () => {
        // Revocation does not shorten retention: a revoked family still has to
        // recognise a replay of its tokens for as long as they could be
        // presented, which is what makes the answer `revoked` rather than
        // `unknown`.
        await issue("tok-revoked-live");
        await harness.store.revoke("tok-revoked-live");

        await expect(harness.store.prune(new Date())).resolves.toBe(0);
        expect((await harness.store.consume("tok-revoked-live")).outcome).toBe("revoked");
      });
    });
  });
}
