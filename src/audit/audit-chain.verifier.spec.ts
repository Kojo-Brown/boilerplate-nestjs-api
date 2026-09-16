import { InMemoryAuditLogStore } from "@/test-utils/in-memory-audit-log.store";
import { InMemoryTransactionRunner } from "@/test-utils/in-memory-transaction.runner";
import { AuditChainVerifier } from "./audit-chain.verifier";
import type { AuditEntry, AuditActionName } from "./audit-entry";
import { auditEntryHash, GENESIS_HASH } from "./audit-hash";
import { AuditLog } from "./audit-log.service";

/**
 * The verifier against a real chain, tampered with by hand.
 *
 * The double is the right substrate for this precisely *because* it lets a spec
 * reach in and edit an entry: in Postgres the same edit is refused by a trigger,
 * so reproducing these four failures there means disabling the trigger first —
 * which `test/audit-log-store.db-spec.ts` does, once, to show the chain still
 * catches what the trigger was there to prevent.
 */
describe("AuditChainVerifier", () => {
  let store: InMemoryAuditLogStore;
  let transactions: InMemoryTransactionRunner;
  let audit: AuditLog;
  let verifier: AuditChainVerifier;

  beforeEach(() => {
    store = new InMemoryAuditLogStore();
    transactions = new InMemoryTransactionRunner();
    audit = new AuditLog(store);
    verifier = new AuditChainVerifier(store);
  });

  const append = (resourceId: string) =>
    transactions.run((tx) =>
      audit.record(tx, "user.deleted", resourceId, { email: `${resourceId}@example.test` }),
    );

  async function appendMany(count: number): Promise<AuditEntry[]> {
    const written: AuditEntry[] = [];
    for (let index = 1; index <= count; index += 1) written.push(await append(`usr-${index}`));
    return written;
  }

  /** Replaces an entry in place, as somebody with UPDATE on the table would. */
  function tamper(seq: bigint, change: Partial<AuditEntry>): void {
    const index = store.entries.findIndex((entry) => entry.seq === seq);
    store.entries[index] = { ...store.entries[index]!, ...change };
  }

  it("reports an empty chain as intact, with nothing to anchor on", async () => {
    await expect(verifier.verify()).resolves.toEqual({
      intact: true,
      checked: 0,
      firstSeq: null,
      lastSeq: null,
      headHash: null,
      breach: null,
    });
  });

  it("verifies an untouched chain and reports its head", async () => {
    const written = await appendMany(5);

    await expect(verifier.verify()).resolves.toEqual({
      intact: true,
      checked: 5,
      firstSeq: 1n,
      lastSeq: 5n,
      headHash: written.at(-1)!.hash,
      breach: null,
    });
  });

  it("verifies a chain longer than one page, in one report", async () => {
    // VERIFY_PAGE_SIZE is 500; 501 entries is the smallest chain that proves
    // the cursor is carried across the page boundary rather than restarting.
    const written = await appendMany(501);

    const report = await verifier.verify();

    expect(report.intact).toBe(true);
    expect(report.checked).toBe(501);
    expect(report.headHash).toBe(written.at(-1)!.hash);
  });

  it("catches an entry whose contents were edited", async () => {
    await appendMany(3);
    tamper(2n, { details: { email: "rewritten@example.test" } });

    const report = await verifier.verify();

    expect(report.intact).toBe(false);
    expect(report.breach).toMatchObject({ seq: 2n, kind: "forged-hash" });
    // Everything before the breach did verify, and the report says how far it
    // got — which is what tells an investigator the entries they can still rely
    // on.
    expect(report.checked).toBe(1);
    expect(report.lastSeq).toBe(1n);
  });

  it("catches an edited entry that was re-hashed to cover it up", async () => {
    const written = await appendMany(3);
    const forged = { ...written[1]!, details: { email: "rewritten@example.test" } };
    tamper(2n, { ...forged, hash: auditEntryHash(forged) });

    const report = await verifier.verify();

    // The forged entry hashes to itself perfectly. What gives it away is entry
    // 3, which still names the hash entry 2 used to have — so re-hashing one
    // row means re-hashing every row after it.
    expect(report.breach).toMatchObject({ seq: 3n, kind: "broken-link" });
  });

  it("catches a deleted entry, which neither hash check would", async () => {
    await appendMany(4);
    store.entries.splice(1, 1);

    const report = await verifier.verify();

    // Entries 1, 3 and 4 all hash perfectly and 4 still links to 3. Only the
    // missing number shows anything happened — which is why `seq` is assigned
    // under a lock rather than by a sequence that leaves innocent gaps.
    expect(report.breach).toMatchObject({ seq: 2n, kind: "gap" });
    expect(report.breach?.detail).toContain("1 is followed by 3");
  });

  it("catches entries removed from the front of the chain", async () => {
    await appendMany(3);
    store.entries.splice(0, 1);

    const report = await verifier.verify();

    expect(report.breach).toMatchObject({ seq: 1n, kind: "wrong-genesis" });
    expect(report.checked).toBe(0);
  });

  it("catches a first entry re-anchored on something other than the genesis hash", async () => {
    await appendMany(2);
    const relinked = { ...store.entries[0]!, prevHash: "a".repeat(64) };
    tamper(1n, { ...relinked, hash: auditEntryHash(relinked) });

    const report = await verifier.verify();

    // Re-hashed, so it is internally consistent; it just claims a predecessor
    // that cannot exist. This is the splice GENESIS_HASH is there to refuse.
    expect(report.breach).toMatchObject({ seq: 1n, kind: "broken-link" });
    expect(report.breach?.detail).toContain(GENESIS_HASH);
  });

  it("verifies entries whose action this build no longer knows", async () => {
    await appendMany(2);
    // A deploy retired the action after the entry was written — which, in a
    // table nothing may delete from, is a state the verifier meets forever.
    // Verification never consults the catalogue, and this is why.
    const retired = { ...store.entries[1]!, action: "user.suspended" as AuditActionName };
    tamper(2n, { ...retired, hash: auditEntryHash(retired) });

    await expect(verifier.verify()).resolves.toMatchObject({ intact: true, checked: 2 });
  });

  it("reports the first breach only, and stops there", async () => {
    await appendMany(5);
    tamper(2n, { details: { email: "first@example.test" } });
    tamper(4n, { details: { email: "second@example.test" } });

    const report = await verifier.verify();

    expect(report.breach?.seq).toBe(2n);
    expect(report.checked).toBe(1);
  });
});
