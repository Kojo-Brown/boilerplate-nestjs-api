import { formatCursor, parseCursor } from "./stream-cursor";

const EPOCH = "0f8c1a2b3d4e5f60718293a4b5c6d7e8";

describe("stream cursor", () => {
  it("round-trips a formatted cursor", () => {
    expect(parseCursor(formatCursor(EPOCH, 42))).toEqual({ epoch: EPOCH, seq: 42 });
  });

  it("accepts position zero, which means 'before the first event'", () => {
    expect(parseCursor(formatCursor(EPOCH, 0))).toEqual({ epoch: EPOCH, seq: 0 });
  });

  it("tolerates the surrounding whitespace a header may carry", () => {
    expect(parseCursor(`  ${EPOCH}.7 `)).toEqual({ epoch: EPOCH, seq: 7 });
  });

  /**
   * The reason this parser exists rather than a `Number()` call. Every one of
   * these coerces to `0` or to something ordered, and `0` is the request to
   * replay the entire buffer — so a blank header from a proxy that normalises
   * missing values, or a cursor from a client of a different service, would
   * each be served a backlog instead of being told the resume failed.
   */
  it.each([
    ["undefined", undefined],
    ["null", null],
    ["empty", ""],
    ["blank", "   "],
    ["a bare number", "42"],
    ["a bare epoch", EPOCH],
    ["a negative position", `${EPOCH}.-1`],
    ["a fractional position", `${EPOCH}.1.5`],
    ["a leading zero", `${EPOCH}.007`],
    ["an uppercase epoch", `${EPOCH.toUpperCase()}.1`],
    ["a short epoch", `${EPOCH.slice(0, 31)}.1`],
    ["a long epoch", `${EPOCH}f.1`],
    ["a non-hex epoch", `${EPOCH.slice(0, 31)}z.1`],
    ["trailing junk", `${EPOCH}.1x`],
    ["a second cursor appended", `${EPOCH}.1,${EPOCH}.2`],
  ])("rejects %s", (_label, raw) => {
    expect(parseCursor(raw)).toBeNull();
  });

  /**
   * 16 digits reaches past `Number.MAX_SAFE_INTEGER`, where `Number()` starts
   * rounding — two distinct cursors would then parse to the same position and
   * the replay window would silently start in the wrong place. Rejecting is the
   * only answer that does not require being right about which one it was.
   */
  it("rejects a position too wide to survive Number()", () => {
    expect(parseCursor(`${EPOCH}.999999999999999`)).toEqual({
      epoch: EPOCH,
      seq: 999_999_999_999_999,
    });
    expect(parseCursor(`${EPOCH}.9999999999999999`)).toBeNull();
  });

  it("keeps every position it accepts a safe integer", () => {
    const parsed = parseCursor(`${EPOCH}.999999999999999`);
    expect(Number.isSafeInteger(parsed?.seq)).toBe(true);
  });
});
