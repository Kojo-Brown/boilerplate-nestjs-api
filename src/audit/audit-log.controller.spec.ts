import { InMemoryAuditLogStore } from "@/test-utils/in-memory-audit-log.store";
import { InMemoryTransactionRunner } from "@/test-utils/in-memory-transaction.runner";
import { AuditChainVerifier } from "./audit-chain.verifier";
import { AuditLog } from "./audit-log.service";
import { AuditLogController } from "./audit-log.controller";
import { GENESIS_HASH } from "./audit-hash";
import { ListAuditLogQueryDto } from "./dto/list-audit-log-query.dto";

function query(overrides: Partial<ListAuditLogQueryDto> = {}): ListAuditLogQueryDto {
  return { limit: 50, ...overrides };
}

describe("AuditLogController", () => {
  let store: InMemoryAuditLogStore;
  let controller: AuditLogController;

  beforeEach(() => {
    store = new InMemoryAuditLogStore();
    controller = new AuditLogController(store, new AuditChainVerifier(store));
  });

  const append = (resourceId: string) => {
    const audit = new AuditLog(store);
    return new InMemoryTransactionRunner().run((tx) =>
      audit.record(
        tx,
        "user.deleted",
        resourceId,
        { email: `${resourceId}@example.test` },
        { actor: { id: "adm-1", role: "ADMIN" }, correlationId: "corr-1" },
      ),
    );
  };

  it("renders seq as a decimal string, because JSON has no bigint", async () => {
    const written = await append("usr-1");

    const [entry] = await controller.list(query());

    // `JSON.stringify` throws on a BigInt rather than coercing it, so a `seq`
    // that reached the envelope interceptor unconverted would be a 500 on every
    // response — and `Number(seq)` would round silently past 2^53.
    expect(entry!.seq).toBe("1");
    expect(() => JSON.stringify(entry)).not.toThrow();
    expect(entry).toEqual({
      seq: "1",
      occurredAt: written.occurredAt.toISOString(),
      action: "user.deleted",
      resourceType: "user",
      resourceId: "usr-1",
      details: { email: "usr-1@example.test" },
      actorId: "adm-1",
      actorRole: "ADMIN",
      correlationId: "corr-1",
      prevHash: GENESIS_HASH,
      hash: written.hash,
    });
  });

  it("pages forward from afterSeq, in chain order", async () => {
    await append("usr-1");
    await append("usr-2");
    await append("usr-3");

    const first = await controller.list(query({ limit: 2 }));
    const second = await controller.list(query({ afterSeq: first.at(-1)!.seq, limit: 2 }));

    expect(first.map((entry) => entry.seq)).toEqual(["1", "2"]);
    expect(second.map((entry) => entry.seq)).toEqual(["3"]);
  });

  it("answers a cursor past the end with an empty page rather than an error", async () => {
    await append("usr-1");

    await expect(controller.list(query({ afterSeq: "99999999999999999999" }))).resolves.toEqual([]);
  });

  it("reports an intact chain", async () => {
    const written = await append("usr-1");

    await expect(controller.verify()).resolves.toEqual({
      intact: true,
      checked: 1,
      firstSeq: "1",
      lastSeq: "1",
      headHash: written.hash,
      breach: null,
    });
  });

  it("reports a breach with its position as a string too", async () => {
    await append("usr-1");
    await append("usr-2");
    store.entries[1] = { ...store.entries[1]!, details: { email: "rewritten@example.test" } };

    const report = await controller.verify();

    expect(report.intact).toBe(false);
    expect(report.breach).toMatchObject({ seq: "2", kind: "forged-hash" });
    expect(() => JSON.stringify(report)).not.toThrow();
  });
});
