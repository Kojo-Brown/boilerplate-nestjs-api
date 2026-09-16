import { Inject, Injectable } from "@nestjs/common";
import type { AuditEntry } from "./audit-entry";
import { auditEntryHash, FIRST_SEQ, GENESIS_HASH } from "./audit-hash";
import { AUDIT_LOG_STORE, type AuditLogStore } from "./ports";

/**
 * How many entries are read per round trip.
 *
 * The whole chain has to be walked in order, so this is purely a memory/round
 * trip trade: nothing about the result changes with it, which is why it is a
 * constant here rather than a setting somebody has to reason about.
 */
const VERIFY_PAGE_SIZE = 500;

/** What went wrong, and where. */
export type AuditChainBreachKind =
  /** The chain does not start at the genesis entry — something in front of it is gone. */
  | "wrong-genesis"
  /** A `seq` is missing: an entry was removed, or never committed. */
  | "gap"
  /** An entry's `prevHash` does not name the entry before it. */
  | "broken-link"
  /** An entry's stored `hash` is not the hash of its own contents. */
  | "forged-hash";

export interface AuditChainBreach {
  /** The first entry that fails. Everything before it verified. */
  readonly seq: bigint;
  readonly kind: AuditChainBreachKind;
  readonly detail: string;
}

export interface AuditChainReport {
  readonly intact: boolean;
  readonly checked: number;
  readonly firstSeq: bigint | null;
  readonly lastSeq: bigint | null;
  /**
   * The hash of the last entry checked, which is the whole chain's fingerprint:
   * one value that changes if *any* entry before it changes.
   */
  readonly headHash: string | null;
  /** The first failure found, or `null`. Verification stops at it. */
  readonly breach: AuditChainBreach | null;
}

/**
 * Walks the chain and reports the first place it stops adding up.
 *
 * Three distinct properties are checked, and each catches a different attack:
 *
 * - **recomputing every hash** catches an entry whose contents were edited. The
 *   append-only trigger makes that require dropping the trigger first, which is
 *   the point: the chain is the layer that still works once somebody with
 *   `ALTER TABLE` is in play.
 * - **checking each `prevHash` against the previous entry** catches an entry
 *   that was re-hashed after being edited. Re-hashing one row is easy; it
 *   orphans every row after it, so the forger has to rewrite the rest of the
 *   table too.
 * - **checking `seq` is contiguous from 1** catches a *deletion*, which neither
 *   of the other two would. Remove entry 7 and entries 1–6 and 8–n still hash
 *   perfectly; only the missing number gives it away. This is why `seq` is
 *   assigned under a lock rather than by a sequence — a sequence leaves gaps of
 *   its own, and a gap that might be innocent is not evidence of anything.
 *
 * What it cannot catch is a forger who rewrites the entire table from the
 * genesis entry forwards: the result is a perfectly valid chain of a history
 * that did not happen. Nothing held only by the party being audited can catch
 * that, which is what {@link AuditChainReport.headHash} is for — published
 * somewhere outside this system's reach, it pins everything written before it.
 * `docs/audit-log.md` spells that out.
 */
@Injectable()
export class AuditChainVerifier {
  constructor(@Inject(AUDIT_LOG_STORE) private readonly store: AuditLogStore) {}

  /**
   * Verifies the whole chain, from the genesis entry to the head.
   *
   * Reads in pages and holds one entry at a time, so a table of any size
   * verifies in bounded memory. It is a scan, and a long one on a mature table:
   * this is an operator's endpoint and a scheduled job's, not a request path's.
   */
  async verify(): Promise<AuditChainReport> {
    let previous: AuditEntry | null = null;
    let checked = 0;
    let firstSeq: bigint | null = null;

    for (;;) {
      const page = await this.store.read({
        limit: VERIFY_PAGE_SIZE,
        ...(previous ? { afterSeq: previous.seq } : {}),
      });
      if (page.length === 0) break;

      for (const entry of page) {
        const breach = inspect(entry, previous);
        if (breach) {
          return {
            intact: false,
            checked,
            firstSeq,
            lastSeq: previous?.seq ?? null,
            headHash: previous?.hash ?? null,
            breach,
          };
        }
        firstSeq ??= entry.seq;
        previous = entry;
        checked += 1;
      }

      // A short page is the end of the table. Checking this rather than looping
      // until an empty page saves one round trip on every verification, and on
      // a chain shorter than a page it is the difference between one query and
      // two.
      if (page.length < VERIFY_PAGE_SIZE) break;
    }

    return {
      intact: true,
      checked,
      firstSeq,
      lastSeq: previous?.seq ?? null,
      headHash: previous?.hash ?? null,
      breach: null,
    };
  }
}

/** The three checks, in the order that gives the most specific answer first. */
function inspect(entry: AuditEntry, previous: AuditEntry | null): AuditChainBreach | null {
  const expectedSeq = previous ? previous.seq + 1n : FIRST_SEQ;
  if (entry.seq !== expectedSeq) {
    return {
      seq: expectedSeq,
      kind: previous ? "gap" : "wrong-genesis",
      detail: previous
        ? `Entry ${expectedSeq} is missing: ${previous.seq} is followed by ${entry.seq}.`
        : `The chain starts at ${entry.seq} rather than ${FIRST_SEQ}, so ` +
          `${entry.seq - FIRST_SEQ} entries have been removed from the front.`,
    };
  }

  const expectedPrevHash = previous ? previous.hash : GENESIS_HASH;
  if (entry.prevHash !== expectedPrevHash) {
    return {
      seq: entry.seq,
      kind: "broken-link",
      detail:
        `Entry ${entry.seq} links to ${entry.prevHash}, but entry ${expectedSeq - 1n} hashes ` +
        `to ${expectedPrevHash}.`,
    };
  }

  // Last, because it is the only check that re-encodes the entry — and because
  // an entry that fails one of the two above would fail this one too, for a
  // reason that says much less about what happened.
  const recomputed = auditEntryHash(entry);
  if (recomputed !== entry.hash) {
    return {
      seq: entry.seq,
      kind: "forged-hash",
      detail:
        `Entry ${entry.seq} stores hash ${entry.hash}, but its contents hash to ${recomputed}. ` +
        `The row has been modified since it was written.`,
    };
  }

  return null;
}
