import { InstantiationLedger, RECENT_INSTANCE_IDS } from "./instantiation-ledger.service";

describe("InstantiationLedger", () => {
  let ledger: InstantiationLedger;

  beforeEach(() => {
    ledger = new InstantiationLedger();
  });

  it("counts constructions per provider and hands each instance a unique id", () => {
    const first = ledger.record("RequestContextService");
    const second = ledger.record("RequestContextService");
    const other = ledger.record("AuditTrailService");

    expect([first, second, other]).toEqual([
      "RequestContextService#1",
      "RequestContextService#2",
      "AuditTrailService#3",
    ]);
    expect(ledger.countFor("RequestContextService")).toBe(2);
    expect(ledger.countFor("AuditTrailService")).toBe(1);
  });

  it("reports zero for a provider that has never been constructed", () => {
    expect(ledger.countFor("NeverBuilt")).toBe(0);
    expect(ledger.recentInstanceIdsFor("NeverBuilt")).toEqual([]);
    expect(ledger.entryFor("NeverBuilt")).toEqual({ constructions: 0, recentInstanceIds: [] });
  });

  it("keeps counting exactly while holding only the most recent ids", () => {
    const total = RECENT_INSTANCE_IDS + 5;
    for (let i = 0; i < total; i += 1) ledger.record("RequestContextService");

    const recent = ledger.recentInstanceIdsFor("RequestContextService");

    // The bound is what stops a per-request provider from turning this into a
    // memory leak; the count has to stay exact regardless.
    expect(ledger.countFor("RequestContextService")).toBe(total);
    expect(recent).toHaveLength(RECENT_INSTANCE_IDS);
    expect(recent[0]).toBe(`RequestContextService#${total - RECENT_INSTANCE_IDS + 1}`);
    expect(recent[recent.length - 1]).toBe(`RequestContextService#${total}`);
  });

  it("hands out copies, so a caller cannot edit the ledger through its own snapshot", () => {
    ledger.record("FeatureFlagCache");

    // The `readonly` is cast away deliberately: the point is that the caller
    // cannot reach the real array even when it tries.
    (ledger.recentInstanceIdsFor("FeatureFlagCache") as string[]).push("forged");
    const snapshot = ledger.snapshot();

    expect(snapshot["FeatureFlagCache"]).toEqual({
      constructions: 1,
      recentInstanceIds: ["FeatureFlagCache#1"],
    });
  });

  it("snapshots every provider that has recorded a construction", () => {
    ledger.record("FeatureFlagCache");
    ledger.record("RequestContextService");
    ledger.record("RequestContextService");

    expect(ledger.snapshot()).toEqual({
      FeatureFlagCache: { constructions: 1, recentInstanceIds: ["FeatureFlagCache#1"] },
      RequestContextService: {
        constructions: 2,
        recentInstanceIds: ["RequestContextService#2", "RequestContextService#3"],
      },
    });
  });

  it("starts the sequence over after a reset", () => {
    ledger.record("FeatureFlagCache");
    ledger.reset();

    expect(ledger.snapshot()).toEqual({});
    expect(ledger.record("FeatureFlagCache")).toBe("FeatureFlagCache#1");
  });
});
