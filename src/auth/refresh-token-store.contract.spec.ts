import { Role } from "@prisma/client";
import { describeRefreshTokenStoreContract } from "./refresh-token-store.contract";
import { InMemoryRefreshTokenStore } from "@/test-utils/in-memory-refresh-token.store";
import type { TokenOwner } from "@/test-utils/in-memory-refresh-token.store";

function storeWithOwner(owner: TokenOwner) {
  const owners = new Map([[owner.id, owner]]);
  return {
    store: new InMemoryRefreshTokenStore((id) => owners.get(id)),
    owners,
  };
}

const ADA: TokenOwner = { id: "user-1", email: "ada@example.test", role: Role.USER };

/**
 * The contract against the in-memory double.
 *
 * `PrismaRefreshTokenStore` is held to the same contract by
 * `test/refresh-token-store.db-spec.ts`, which needs a real Postgres: the
 * exclusion it provides *is* `SELECT … FOR UPDATE`, and no fake `PrismaService`
 * could stand in for it without reimplementing the property under test. The
 * adapter's absence from this suite is deliberate, not an omission.
 */
describeRefreshTokenStoreContract("InMemoryRefreshTokenStore", () =>
  Promise.resolve({ store: storeWithOwner(ADA).store, owner: ADA }),
);

describe("InMemoryRefreshTokenStore", () => {
  const expiresAt = () => new Date(Date.now() + 3_600_000);

  it("reports a token as gone once consumed", async () => {
    const { store } = storeWithOwner(ADA);
    await store.issue({ token: "t", userId: ADA.id, expiresAt: expiresAt() });

    expect(store.has("t")).toBe(true);
    await store.consume("t");
    expect(store.has("t")).toBe(false);
  });

  it("resolves with null, and drops the token, when its owner is gone", async () => {
    const { store, owners } = storeWithOwner(ADA);
    await store.issue({ token: "t", userId: ADA.id, expiresAt: expiresAt() });

    owners.delete(ADA.id);

    await expect(store.consume("t")).resolves.toBeNull();
    expect(store.has("t")).toBe(false);
  });

  it("drops the claim chain for a token once it drains", async () => {
    const { store } = storeWithOwner(ADA);

    await store.consume("absent-1");
    await store.consume("absent-2");
    // The cleanup is a continuation on the chain, so it lands one microtask
    // after the caller resumes. Draining the queue is what "eventually" means
    // here; the property is that nothing is left, not that it is gone
    // synchronously.
    await new Promise((resolve) => setImmediate(resolve));

    // A per-token entry that outlives its claim is an unbounded leak on a store
    // that sees a new token on every login.
    const claims = (store as unknown as { claims: Map<string, unknown> }).claims;
    expect(claims.size).toBe(0);
  });

  it("clears every token on reset", async () => {
    const { store } = storeWithOwner(ADA);
    await store.issue({ token: "t", userId: ADA.id, expiresAt: expiresAt() });

    store.reset();

    expect(store.has("t")).toBe(false);
  });
});
