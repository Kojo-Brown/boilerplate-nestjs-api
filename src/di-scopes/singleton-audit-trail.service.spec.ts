import type { AuditEntry } from "./audit-trail.service";
import { AUDIT_BUFFER_LIMIT, SingletonAuditTrail } from "./singleton-audit-trail.service";
import { InstantiationLedger } from "./instantiation-ledger.service";

describe("SingletonAuditTrail", () => {
  let trail: SingletonAuditTrail;

  beforeEach(() => {
    trail = new SingletonAuditTrail(new InstantiationLedger());
  });

  it("accumulates entries across the calls of many different requests", () => {
    trail.record("users.update", "corr-1");
    trail.record("users.delete", "corr-2");

    expect(trail.entries()).toEqual([
      { action: "users.update", correlationId: "corr-1" },
      { action: "users.delete", correlationId: "corr-2" },
    ]);
    expect(trail.droppedCount()).toBe(0);
  });

  it("drops the oldest entries rather than growing without bound", () => {
    for (let i = 0; i < AUDIT_BUFFER_LIMIT + 3; i += 1) trail.record(`action-${i}`, "corr-1");

    const entries = trail.entries();

    // A singleton's memory is the process's memory: the buffer that a
    // request-scoped provider would have had freed with its request has to be
    // bounded here instead.
    expect(entries).toHaveLength(AUDIT_BUFFER_LIMIT);
    expect(entries[0]?.action).toBe("action-3");
    expect(entries[entries.length - 1]?.action).toBe(`action-${AUDIT_BUFFER_LIMIT + 2}`);
    expect(trail.droppedCount()).toBe(3);
  });

  it("hands out a copy of the buffer", () => {
    trail.record("users.update", "corr-1");

    // The `readonly` is cast away deliberately: the point is that the caller
    // cannot reach the real buffer even when it tries.
    (trail.entries() as AuditEntry[]).push({ action: "forged", correlationId: "corr-9" });

    expect(trail.entries()).toHaveLength(1);
  });
});
