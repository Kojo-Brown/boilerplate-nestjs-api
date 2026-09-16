import type { TransactionRunner } from "@/common/prisma/transaction.port";
import type { AuditActionName, NewAuditEntry } from "./audit-entry";
import { auditEntryHash, GENESIS_HASH } from "./audit-hash";
import type { AuditLogStore } from "./ports";

/** What a suite must supply to run the contract. */
export interface AuditLogStoreHarness {
  readonly store: AuditLogStore;
  /** Opens a unit of work the store can append inside. */
  readonly transactions: TransactionRunner;
}

/**
 * The behavioural contract every audit-log store must satisfy.
 *
 * Written once and run against both implementations — against Postgres in
 * `test/audit-log-store.db-spec.ts`, and against the in-memory double in
 * `audit-log-store.contract.spec.ts`. The types already line up; what this pins
 * is the behaviour a plausible fake would get wrong:
 *
 * 1. the first entry chains to the genesis hash, and every later one to its
 *    predecessor;
 * 2. `seq` is contiguous, with no number skipped and none reused;
 * 3. an entry disappears with the transaction that wrote it;
 * 4. two entries in one transaction chain to each other, not both to the tail
 *    the transaction started with;
 * 5. `read` pages forward in chain order.
 *
 * Property 3 is the one that has to hold in both places: the Postgres store
 * gets it from the transaction, the double gets it from `onRollback`, and the
 * e2e suite — which runs the whole application on the double — would silently
 * rely on it either way.
 */
export function describeAuditLogStoreContract(
  name: string,
  createHarness: () => Promise<AuditLogStoreHarness>,
): void {
  describe(`${name} (audit log store contract)`, () => {
    let harness: AuditLogStoreHarness;
    let sequence = 0;

    /**
     * Only the envelope is overridable. `action` and `details` are fixed
     * together or not at all — they are correlated, and a
     * `Partial<NewAuditEntry>` would let a caller replace one and leave the
     * other.
     */
    type EnvelopeOverrides = Partial<
      Pick<NewAuditEntry, "resourceId" | "actor" | "correlationId" | "occurredAt">
    >;

    function draft(overrides: EnvelopeOverrides = {}): NewAuditEntry<"user.deleted"> {
      sequence += 1;
      return {
        action: "user.deleted",
        resourceId: `usr-${sequence}`,
        details: { email: `contract-${sequence}@example.test` },
        actor: { id: "adm-1", role: "ADMIN" },
        correlationId: `corr-${sequence}`,
        occurredAt: new Date(Date.UTC(2026, 8, 16, 12, 0, sequence)),
        ...overrides,
      };
    }

    const append = (overrides: EnvelopeOverrides = {}) =>
      harness.transactions.run((tx) => harness.store.append(tx, draft(overrides)));

    beforeEach(async () => {
      harness = await createHarness();
    });

    it("anchors the first entry on the genesis hash", async () => {
      const first = await append();

      expect(first.seq).toBe(1n);
      expect(first.prevHash).toBe(GENESIS_HASH);
      expect(first.hash).toMatch(/^[0-9a-f]{64}$/);
      await expect(harness.store.head()).resolves.toEqual(first);
    });

    it("links each entry to the one before it", async () => {
      const first = await append();
      const second = await append();
      const third = await append();

      expect([second.prevHash, third.prevHash]).toEqual([first.hash, second.hash]);
      expect([second.seq, third.seq]).toEqual([2n, 3n]);
    });

    it("seals the entry it returns with the hash it stored", async () => {
      const written = await append({ actor: null, correlationId: null });

      const [read] = await harness.store.read({ limit: 1 });
      expect(read).toEqual(written);
      // The stored hash really is the hash of the stored contents — not a value
      // the store could have invented, and the property the verifier rests on.
      expect(auditEntryHash(read!)).toBe(read!.hash);
    });

    it("derives resourceType from the action rather than from the caller", async () => {
      const entry = await append();

      // `user.deleted` is registered against `user` in AUDIT_ACTIONS, and there
      // is no argument a caller could have passed to make this say anything
      // else.
      expect(entry.resourceType).toBe("user");
    });

    it("drops an entry whose transaction rolled back, and reuses its number", async () => {
      const first = await append();

      const failure = new Error("the audited operation failed");
      await expect(
        harness.transactions.run(async (tx) => {
          await harness.store.append(tx, draft());
          throw failure;
        }),
      ).rejects.toBe(failure);

      // Not merely absent: the number it took has to be available again, or the
      // chain carries a gap that is indistinguishable from a deleted entry.
      const next = await append();
      expect(next.seq).toBe(2n);
      expect(next.prevHash).toBe(first.hash);
      await expect(harness.store.count()).resolves.toBe(2);
    });

    it("chains two entries written in one transaction to each other", async () => {
      const first = await append();

      const [second, third] = await harness.transactions.run(async (tx) => [
        await harness.store.append(tx, draft()),
        await harness.store.append(tx, draft()),
      ]);

      // The trap: reading the tail outside the transaction would make both of
      // these chain to `first`, so the second would overwrite the first's link
      // and the chain would fork.
      expect(second!.prevHash).toBe(first.hash);
      expect(third!.prevHash).toBe(second!.hash);
      expect([second!.seq, third!.seq]).toEqual([2n, 3n]);
    });

    it("pages forward in chain order from a cursor", async () => {
      const written = [await append(), await append(), await append()];

      const firstPage = await harness.store.read({ limit: 2 });
      const secondPage = await harness.store.read({ afterSeq: firstPage.at(-1)!.seq, limit: 2 });

      expect(firstPage.map((entry) => entry.seq)).toEqual([1n, 2n]);
      expect(secondPage.map((entry) => entry.seq)).toEqual([3n]);
      expect([...firstPage, ...secondPage]).toEqual(written);
    });

    it("reports an empty log without inventing a head", async () => {
      await expect(harness.store.head()).resolves.toBeNull();
      await expect(harness.store.read({ limit: 10 })).resolves.toEqual([]);
      await expect(harness.store.count()).resolves.toBe(0);
    });

    it("records the actor's role as it was at the time, and null for the system", async () => {
      const byUser = await append({ actor: { id: "usr-7", role: "USER" } });
      const bySystem = await append({ actor: null });

      expect([byUser.actorId, byUser.actorRole]).toEqual(["usr-7", "USER"]);
      expect([bySystem.actorId, bySystem.actorRole]).toEqual([null, null]);
    });

    it("refuses details that cannot be hashed unambiguously, before writing anything", async () => {
      await expect(
        harness.transactions.run((tx) =>
          harness.store.append(tx, {
            ...draft(),
            // Reachable one way: a nullable field read back empty and passed
            // through. `JSON.stringify` would drop the key, so this entry and
            // one without the field would hash identically.
            details: { email: undefined } as unknown as { email: string },
          }),
        ),
      ).rejects.toThrow(/cannot be hashed/);

      await expect(harness.store.count()).resolves.toBe(0);
    });

    it("refuses an action the catalogue does not know rather than inventing its resourceType", async () => {
      // Reachable only one way: a name widened through an `unknown` on its way
      // in. Writing it would put `undefined` in a NOT NULL column — or, worse,
      // an empty string — in a table nothing can go back and correct.
      const unregistered = "user.suspended" as AuditActionName;

      await expect(
        harness.transactions.run((tx) =>
          harness.store.append(tx, { ...draft(), action: unregistered }),
        ),
      ).rejects.toThrow(/not in AUDIT_ACTIONS/);

      await expect(harness.store.count()).resolves.toBe(0);
    });
  });
}
