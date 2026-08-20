import { encodeCsv } from "./csv-encode.task";

/**
 * Tests the encoding rules that make a CSV round-trip cleanly.
 *
 * RFC 4180 permits a lot, so pinning behaviour on the tricky cases (embedded
 * quotes, commas, CR/LF, empty cells, nullish values) here is what stops a
 * downstream spreadsheet from silently rearranging rows.
 */

const cols = [
  { key: "id", header: "ID" },
  { key: "name", header: "Name" },
];

function decode(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

describe("encodeCsv", () => {
  it("writes header and a plain row", () => {
    const out = encodeCsv({ columns: cols, rows: [{ id: "u1", name: "Ada" }] });
    expect(decode(out.bytes)).toBe("ID,Name\r\nu1,Ada\r\n");
    expect(out.rowCount).toBe(1);
    expect(out.byteLength).toBe(out.bytes.byteLength);
  });

  it("quotes a cell containing a comma", () => {
    const out = encodeCsv({ columns: cols, rows: [{ id: "u1", name: "Ada, Lovelace" }] });
    expect(decode(out.bytes)).toBe('ID,Name\r\nu1,"Ada, Lovelace"\r\n');
  });

  it("doubles quotes and wraps the cell", () => {
    const out = encodeCsv({ columns: cols, rows: [{ id: "u1", name: 'Grace "Amazing" Hopper' }] });
    expect(decode(out.bytes)).toBe('ID,Name\r\nu1,"Grace ""Amazing"" Hopper"\r\n');
  });

  it("quotes a cell containing CR or LF", () => {
    const out = encodeCsv({ columns: cols, rows: [{ id: "u1", name: "line1\nline2" }] });
    expect(decode(out.bytes)).toBe('ID,Name\r\nu1,"line1\nline2"\r\n');
  });

  it("emits an empty cell for a missing key", () => {
    const out = encodeCsv({ columns: cols, rows: [{ id: "u1" }] });
    expect(decode(out.bytes)).toBe("ID,Name\r\nu1,\r\n");
  });

  it("emits an empty cell for null", () => {
    const out = encodeCsv({ columns: cols, rows: [{ id: "u1", name: null }] });
    expect(decode(out.bytes)).toBe("ID,Name\r\nu1,\r\n");
  });

  it("stringifies numbers and booleans", () => {
    const out = encodeCsv({
      columns: [
        { key: "n", header: "N" },
        { key: "b", header: "B" },
      ],
      rows: [{ n: 42, b: true }],
    });
    expect(decode(out.bytes)).toBe("N,B\r\n42,true\r\n");
  });

  it("writes NaN as the literal 'NaN' — the caller has to see the wrong number", () => {
    const out = encodeCsv({
      columns: [{ key: "n", header: "N" }],
      rows: [{ n: Number.NaN }],
    });
    // Coercing NaN to an empty cell would hide a caller's bug in the
    // spreadsheet, which is exactly the failure mode this test pins.
    expect(decode(out.bytes)).toBe("N\r\nNaN\r\n");
  });

  it("supports \\n line terminators when asked", () => {
    const out = encodeCsv({
      columns: cols,
      rows: [{ id: "u1", name: "Ada" }],
      eol: "\n",
    });
    expect(decode(out.bytes)).toBe("ID,Name\nu1,Ada\n");
  });

  it("prefixes a UTF-8 BOM when asked", () => {
    const out = encodeCsv({
      columns: cols,
      rows: [{ id: "u1", name: "Ada" }],
      bom: true,
    });
    // The BOM is three bytes: 0xEF 0xBB 0xBF, then the header.
    expect(Array.from(out.bytes.slice(0, 3))).toEqual([0xef, 0xbb, 0xbf]);
  });

  it("handles a large row count without stack overflow", () => {
    const rows = Array.from({ length: 10_000 }, (_, i) => ({ id: `u${i}`, name: `Name ${i}` }));
    const out = encodeCsv({ columns: cols, rows });
    expect(out.rowCount).toBe(10_000);
    expect(out.byteLength).toBeGreaterThan(0);
  });
});
