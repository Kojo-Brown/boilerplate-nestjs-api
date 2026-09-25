import type { EncryptionContext } from "./ports";

/**
 * One column this service stores encrypted.
 *
 * A descriptor rather than two loose strings at the call site, because both
 * halves end up inside authenticated data: get them wrong and nothing fails
 * until a read, and then everything fails at once. Declaring each field in one
 * place — `ORDER_ITEMS_FIELD` in `src/orders` — means the writer and the reader
 * cannot disagree about what was bound.
 */
export interface EncryptedField {
  /** The table as the database spells it, e.g. `orders`. */
  readonly table: string;
  /** The column as the database spells it, e.g. `itemsCiphertext`. */
  readonly column: string;
}

/**
 * Bumping this invalidates every stored envelope, so it is a version and not a
 * comment.
 *
 * It is the first thing in the authenticated data on both layers, which is what
 * makes a future format change safe to deploy alongside this one: a v2 reader
 * handed v1 bytes gets an authentication failure rather than a plausible-looking
 * misparse.
 */
export const FIELD_ENCRYPTION_VERSION = "field-encryption-v1";

/**
 * What a table or column may be called.
 *
 * Narrow on purpose. These strings are length-prefixed into the additional
 * authenticated data below, so an odd one cannot *forge* anything — but they are
 * also what an operator reads in a CloudTrail key-use entry, and they are what
 * two code paths have to agree on byte for byte. A typo caught at module load
 * is a typo that never reaches a row.
 *
 * Columns in this schema are camelCase (`itemsCiphertext`), which is why upper
 * case is allowed.
 */
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Thrown at module load for a field descriptor that cannot be trusted. */
export class InvalidEncryptedFieldError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidEncryptedFieldError";
  }
}

/**
 * Declares an encrypted column.
 *
 * Called at module scope, so anything wrong with it fails the import rather
 * than the first write. There is no runtime check that the column actually
 * exists — that is what `prisma generate` and the migration are for — but there
 * is one that it is spelled like a column, because the *name* is load-bearing
 * here in a way it is not elsewhere.
 */
export function encryptedField(table: string, column: string): EncryptedField {
  for (const [part, value] of [
    ["table", table],
    ["column", column],
  ] as const) {
    if (!IDENTIFIER.test(value)) {
      throw new InvalidEncryptedFieldError(
        `${JSON.stringify(value)} is not a usable ${part} name. It is bound into the ` +
          `authenticated data of every value in this column and read back by an operator in a ` +
          `key-use log, so it has to be a plain identifier.`,
      );
    }
  }

  return Object.freeze({ table, column });
}

/** `table.column`, for log lines, cache keys and error messages. */
export function fieldName(field: EncryptedField): string {
  return `${field.table}.${field.column}`;
}

/**
 * The encryption context a data key for this field is wrapped under.
 *
 * Deliberately **per column and not per row**. One data key serves many records
 * — that is what makes the materials cache in `data-key-cache.ts` possible, and
 * without it every insert and every read would be a KMS round trip. The
 * per-record binding is done one layer down, by {@link recordAad}, where it
 * costs nothing.
 *
 * What this buys at the key layer: a wrapped key lifted from
 * `orders.itemsCiphertext` and presented as some future
 * `users.phoneCiphertext` is refused by KMS itself, and every `Decrypt` in
 * CloudTrail names the column it was for.
 */
export function fieldKeyContext(field: EncryptedField): EncryptionContext {
  return {
    purpose: FIELD_ENCRYPTION_VERSION,
    table: field.table,
    column: field.column,
  };
}

/**
 * One length-prefixed part of an authenticated-data blob.
 *
 * The length prefix is not decoration; it is the difference between authenticated
 * data and a string an attacker shares control of. Joined with a separator
 * instead, a record id of `"a\ncolumn:1:b"` would produce the same bytes as a
 * different field of a different record — so two values would authenticate under
 * each other's context with no weakness in AES-GCM at all. This is the same
 * argument `audit-hash.ts` makes about its preimage, and the same fix.
 */
function part(name: string, value: string): string {
  return `${name}:${Buffer.byteLength(value, "utf8")}:${value}\n`;
}

/**
 * The additional authenticated data for one value: the format version, the
 * column, and the row it belongs to.
 *
 * AES-GCM covers this without storing it, so it costs no bytes in the column
 * and is impossible to strip — a ciphertext copied from another row, or from
 * another column of the same row, fails its tag check instead of decrypting.
 * That matters for a specific attack the encryption alone does not stop: an
 * attacker who can write the database but not read the keys copies a victim's
 * ciphertext onto a row they control and has the application decrypt it for
 * them.
 *
 * The record id must be non-empty, because binding a value to "some row" is not
 * binding it to a row.
 */
export function recordAad(field: EncryptedField, recordId: string): Buffer {
  if (recordId.length === 0) {
    throw new InvalidEncryptedFieldError(
      `A value in ${fieldName(field)} cannot be encrypted without the id of the record it ` +
        `belongs to: the id is what stops the ciphertext being readable on another row.`,
    );
  }

  return Buffer.from(
    part("version", FIELD_ENCRYPTION_VERSION) +
      part("table", field.table) +
      part("column", field.column) +
      part("record", recordId),
    "utf8",
  );
}
