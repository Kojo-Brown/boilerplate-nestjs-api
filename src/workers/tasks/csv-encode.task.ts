// The `declare module` block below augments `WorkerTaskMap` — the import is
// implicit and no runtime symbol from the port needs binding here.

/**
 * Rows and column definitions for `csv.encode`.
 *
 * Records are `Record<string, string | number | boolean | null>` rather than
 * arbitrary `unknown` so a JSON column doesn't decide to encode itself
 * `[object Object]` in a downstream spreadsheet — the caller flattens first
 * and takes the blame for what a value looks like on a row.
 */
export type CsvCell = string | number | boolean | null;

export type CsvRow = Readonly<Record<string, CsvCell>>;

export interface CsvColumn {
  /** Key on the row. A missing key is written as an empty cell. */
  readonly key: string;
  /**
   * Header text. Not the key on purpose: a spreadsheet header column is
   * something a human reads and a column key is an identifier a schema uses,
   * and reusing one for the other means never being able to change either.
   */
  readonly header: string;
}

export interface CsvEncodeInput {
  readonly columns: readonly CsvColumn[];
  readonly rows: readonly CsvRow[];
  /**
   * Line terminator. RFC 4180 says `\r\n`; POSIX tooling prefers `\n`.
   * Default `\r\n` because Excel is the audience most likely to open one of
   * these files, and it displays a lone `\n` as one enormous cell.
   */
  readonly eol?: "\r\n" | "\n";
  /**
   * When true, prefix a UTF-8 byte-order mark. Excel needs one to read
   * non-ASCII cells correctly; every other tool ignores it. Default false —
   * a caller that hands the file to Excel opts in.
   */
  readonly bom?: boolean;
}

export interface CsvEncodeOutput {
  /**
   * The encoded document as UTF-8 bytes. Returned as a `Uint8Array` rather
   * than a string because the size can be arbitrarily large and this crosses
   * `postMessage`: a string is cloned, a `Uint8Array` is transferred.
   */
  readonly bytes: Uint8Array;
  /** Number of data rows in the output, not counting the header. */
  readonly rowCount: number;
  /** Size of `bytes` in bytes. Redundant, but avoids a `.byteLength` round-trip. */
  readonly byteLength: number;
}

/**
 * Encodes rows to RFC 4180 CSV.
 *
 * A cell is quoted iff it contains a quote, a delimiter, or a line break, and
 * a quote inside a quoted cell is doubled. `null` becomes an empty field, and
 * `boolean`/`number` become their `String()` — `NaN` becomes the literal text
 * `NaN`, which is deliberate: a spreadsheet showing `NaN` is a bug the caller
 * has to see, and silently coercing it to empty would hide the wrong number.
 */
export function encodeCsv(input: CsvEncodeInput): CsvEncodeOutput {
  const eol = input.eol ?? "\r\n";
  const parts: string[] = [];

  if (input.bom) parts.push("﻿");

  parts.push(input.columns.map((c) => quoteIfNeeded(c.header)).join(","), eol);

  for (const row of input.rows) {
    const cells = input.columns.map((c) => quoteIfNeeded(cellToString(row[c.key])));
    parts.push(cells.join(","), eol);
  }

  const text = parts.join("");
  const bytes = new TextEncoder().encode(text);
  return { bytes, rowCount: input.rows.length, byteLength: bytes.byteLength };
}

function cellToString(cell: CsvCell | undefined): string {
  if (cell === null || cell === undefined) return "";
  return String(cell);
}

/**
 * Doubles any embedded quotes and wraps the cell in quotes if it contains a
 * character that would otherwise change how the row is parsed. Cheaper than
 * `String#replace` on the common case — most cells need no quoting at all,
 * and this avoids allocating a new string for them.
 */
function quoteIfNeeded(value: string): string {
  let needsQuoting = false;
  for (let i = 0; i < value.length; i++) {
    const ch = value.charCodeAt(i);
    if (
      ch === 0x22 /* " */ ||
      ch === 0x2c /* , */ ||
      ch === 0x0a /* \n */ ||
      ch === 0x0d /* \r */
    ) {
      needsQuoting = true;
      break;
    }
  }
  if (!needsQuoting) return value;
  return `"${value.replace(/"/g, '""')}"`;
}

export interface CsvEncodeTask {
  input: CsvEncodeInput;
  output: CsvEncodeOutput;
}

declare module "../ports/worker-pool.port" {
  interface WorkerTaskMap {
    readonly "csv.encode": CsvEncodeTask;
  }
}
