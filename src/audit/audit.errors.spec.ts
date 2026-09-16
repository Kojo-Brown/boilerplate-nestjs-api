import { AUDIT_LOG_APPEND_ONLY_SQLSTATE, isAppendOnlyViolation } from "./audit.errors";

/**
 * The shape this walks is pinned against a real server in
 * `test/audit-log-store.db-spec.ts`, which is the only thing that would notice
 * Prisma moving it. What is worth asserting here is that every partial shape on
 * the way down is survived rather than thrown on — the helper is called from a
 * `catch`, where a `TypeError` would replace the failure somebody is trying to
 * diagnose.
 */
describe("isAppendOnlyViolation", () => {
  const violation = {
    code: "P2039",
    meta: {
      modelName: "AuditLogEntry",
      driverAdapterError: {
        cause: { kind: "postgres", code: AUDIT_LOG_APPEND_ONLY_SQLSTATE },
      },
    },
  };

  it("recognises the refusal", () => {
    expect(isAppendOnlyViolation(violation)).toBe(true);
  });

  it("does not claim another SQLSTATE", () => {
    // A unique violation arrives through the same path with a different code,
    // and is an ordinary bug rather than an intrusion.
    const unique = { meta: { driverAdapterError: { cause: { code: "23505" } } } };

    expect(isAppendOnlyViolation(unique)).toBe(false);
  });

  it.each([
    ["null", null],
    ["undefined", undefined],
    ["a string", "audit_log is append-only"],
    ["a bare Error", new Error("boom")],
    ["a truncated chain", { meta: { driverAdapterError: {} } }],
    ["a meta that is not an object", { meta: "append-only" }],
    ["an adapter error that is not an object", { meta: { driverAdapterError: "append-only" } }],
    ["a null cause", { meta: { driverAdapterError: { cause: null } } }],
    ["a null meta", { meta: null }],
  ])("survives %s", (_label, error) => {
    expect(isAppendOnlyViolation(error)).toBe(false);
  });
});
