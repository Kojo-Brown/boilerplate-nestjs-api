import { createHash } from "crypto";
import { AUDIT_ACTIONS, type AuditEntry, type NewAuditEntry } from "./audit-entry";

/**
 * What the first entry's `prevHash` is.
 *
 * Sixty-four zeros is not a hash of anything, which is the property that
 * matters: no entry can ever produce it, so nothing can be spliced in front of
 * the genesis entry and still verify. A `null` would have done the same job in
 * the database and a worse one in the hash — a nullable field in the preimage
 * is a second encoding case, and every extra case in a preimage is somewhere
 * two values can collide.
 */
export const GENESIS_HASH = "0".repeat(64);

/** The preimage format. Bumping this invalidates every hash, so it is versioned. */
const PREIMAGE_VERSION = "audit-chain-v1";

/**
 * The seq the first entry takes. One, not zero, so "the chain is `n` long" and
 * "the head is at `n`" are the same number.
 */
export const FIRST_SEQ = 1n;

/** A 64-character lower-case hex string, which is what SHA-256 produces here. */
const HEX_64 = /^[0-9a-f]{64}$/;

export function isChainHash(value: string): boolean {
  return HEX_64.test(value);
}

/**
 * Serialises a JSON value so that equal values always produce equal bytes.
 *
 * `JSON.stringify` does not do this. Object key order follows insertion order,
 * so `{ a: 1, b: 2 }` and `{ b: 2, a: 1 }` — the same value by every meaning the
 * application has — serialise differently and would hash differently. An entry
 * written by one code path and verified by another would then fail
 * verification, which is the worst possible failure for this table: it cries
 * tampering at honest data, and the second time it does that nobody believes it
 * about the real thing.
 *
 * Keys are sorted by UTF-16 code unit, which is what `Array.prototype.sort`
 * compares and therefore the one ordering that needs no collator to reproduce.
 *
 * Everything `JSON.stringify` silently drops or mangles is rejected instead:
 *
 * - `undefined` and functions vanish from objects and become `null` in arrays,
 *   so `{ a: undefined }` and `{}` would hash alike.
 * - `NaN` and `±Infinity` become `null`, so three distinct values collide.
 * - a `BigInt` throws, and a `Date` or a class instance is quietly rewritten by
 *   its own `toJSON` — meaning the bytes that were hashed are not the value the
 *   caller passed.
 *
 * Refusing all of it is the whole point: an entry that cannot be encoded
 * unambiguously must fail the caller's transaction, not be hashed on a guess.
 */
export function canonicalJson(value: unknown, path = "details"): string {
  if (value === null) return "null";

  switch (typeof value) {
    case "string":
      return JSON.stringify(value);
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) {
        throw new AuditEncodingError(`${path} is ${String(value)}, which JSON cannot represent`);
      }
      // `-0` and `0` are `===`, so nothing downstream can tell them apart, but
      // `JSON.stringify(-0)` is `"0"` while `String(-0)` is `"0"` too — the
      // hazard is only that a future encoder might disagree. Normalising here
      // makes the choice explicit rather than inherited.
      return JSON.stringify(value === 0 ? 0 : value);
    case "object":
      break;
    default:
      throw new AuditEncodingError(`${path} is a ${typeof value}, which is not JSON`);
  }

  if (Array.isArray(value)) {
    return `[${value.map((item, index) => canonicalJson(item, `${path}[${index}]`)).join(",")}]`;
  }

  // A `Date`, a `Map`, a Prisma row — anything whose identity is not its own
  // enumerable properties. `JSON.stringify` would happily call `toJSON` or
  // produce `{}`, and hash bytes that do not describe what was passed.
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
    throw new AuditEncodingError(
      `${path} is a ${value.constructor?.name ?? "non-plain object"}. Audit details must be ` +
        `plain JSON: convert it at the call site, where the right representation is known.`,
    );
  }

  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const members = keys.map((key) => {
    const member = record[key];
    if (member === undefined) {
      throw new AuditEncodingError(
        `${path}.${key} is undefined. JSON.stringify would drop the key entirely, so an entry ` +
          `with it and an entry without it would hash the same — use null.`,
      );
    }
    return `${JSON.stringify(key)}:${canonicalJson(member, `${path}.${key}`)}`;
  });
  return `{${members.join(",")}}`;
}

/** Thrown when an entry cannot be encoded unambiguously, before anything is written. */
export class AuditEncodingError extends Error {
  constructor(message: string) {
    super(`This audit entry cannot be hashed: ${message}`);
    this.name = "AuditEncodingError";
  }
}

/**
 * One field of the preimage, length-prefixed.
 *
 * Concatenating fields with a separator is the classic way to build a preimage
 * that two different entries can share. With `|` between them, an entry whose
 * `resourceId` is `"a|b"` and whose `action` is `"c"` produces the same bytes as
 * one with id `"a"` and action `"b|c"` — so an attacker who controls one field
 * controls the boundary, and two entries collide with no collision in SHA-256
 * at all. A byte length in front of every value removes the boundary as a
 * degree of freedom.
 *
 * `null` gets its own marker rather than an empty string, because "no actor"
 * and "an actor whose id is the empty string" must not hash alike. The two
 * forms are distinguishable without ambiguity: a present value always reads
 * `name:<digits>:`, and `null` is not digits.
 */
function field(name: string, value: string | null): string {
  if (value === null) return `${name}:null\n`;
  return `${name}:${Buffer.byteLength(value, "utf8")}:${value}\n`;
}

/** Everything the hash covers. {@link AuditEntry} satisfies it; so does a sealed draft. */
type Hashable = Omit<AuditEntry, "hash">;

/**
 * The exact bytes hashed for an entry. Exported for the docs and for the specs
 * that assert on the format; production code wants {@link auditEntryHash}.
 *
 * Timestamps go in as `toISOString()` — UTC, millisecond precision, one
 * spelling per instant. The column is `TIMESTAMP(3)`, so millisecond precision
 * is what survives a round trip: hashing anything finer would make an entry
 * verify before it was written and fail after.
 */
export function auditEntryPreimage(entry: Hashable): string {
  return (
    field("version", PREIMAGE_VERSION) +
    field("seq", entry.seq.toString()) +
    field("occurredAt", entry.occurredAt.toISOString()) +
    field("action", entry.action) +
    field("resourceType", entry.resourceType) +
    field("resourceId", entry.resourceId) +
    field("actorId", entry.actorId) +
    field("actorRole", entry.actorRole) +
    field("correlationId", entry.correlationId) +
    field("details", canonicalJson(entry.details)) +
    field("prevHash", entry.prevHash)
  );
}

/** SHA-256 of {@link auditEntryPreimage}, lower-case hex. */
export function auditEntryHash(entry: Hashable): string {
  return createHash("sha256").update(auditEntryPreimage(entry), "utf8").digest("hex");
}

/**
 * Places a draft in the chain and seals it.
 *
 * The one function that turns a caller's entry into a row, called by *every*
 * store — the Postgres one and the in-memory double alike. That is deliberate:
 * a double with its own copy of the hashing would be free to drift from the
 * adapter, and the e2e suite would then be asserting on a chain that the real
 * implementation would never produce.
 *
 * `resourceType` comes from {@link AUDIT_ACTIONS} rather than from the caller,
 * so the column and the action it belongs to cannot disagree.
 */
export function sealAuditEntry(draft: NewAuditEntry, seq: bigint, prevHash: string): AuditEntry {
  if (!isChainHash(prevHash) && prevHash !== GENESIS_HASH) {
    throw new AuditEncodingError(`prevHash ${JSON.stringify(prevHash)} is not a chain hash`);
  }

  // TypeScript keeps every call site honest about this, so the only way here is
  // a value widened through an `unknown` — a name read off a queue, say. The
  // alternative to refusing is writing an entry whose `resourceType` is
  // `undefined`, which is an unreadable row in a table nothing can go back and
  // fix.
  const resourceType = AUDIT_ACTIONS[draft.action] as string | undefined;
  if (resourceType === undefined) {
    throw new AuditEncodingError(
      `${JSON.stringify(draft.action)} is not in AUDIT_ACTIONS, so there is no resource type ` +
        `to record it against`,
    );
  }

  const placed: Hashable = {
    seq,
    occurredAt: draft.occurredAt,
    action: draft.action,
    resourceType,
    resourceId: draft.resourceId,
    details: draft.details,
    actorId: draft.actor?.id ?? null,
    actorRole: draft.actor?.role ?? null,
    correlationId: draft.correlationId,
    prevHash,
  };

  return { ...placed, hash: auditEntryHash(placed) };
}
