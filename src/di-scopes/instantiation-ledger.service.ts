import { Injectable } from "@nestjs/common";

/**
 * How many instance ids are kept per provider.
 *
 * The counters are what the lesson needs; the ids are a convenience for seeing
 * *which* instance answered. A request-scoped provider records one id per
 * request forever, so keeping all of them would make this teaching aid the
 * one memory leak in the boilerplate. Counts are exact regardless.
 */
export const RECENT_INSTANCE_IDS = 20;

/** One provider's construction history. */
export interface LedgerEntry {
  /** How many instances of this provider have been constructed, since boot or since the last reset. */
  readonly constructions: number;
  /** The `instanceId` of the most recent instances, oldest first, capped at {@link RECENT_INSTANCE_IDS}. */
  readonly recentInstanceIds: readonly string[];
}

/**
 * Counts constructor calls, so a lifetime becomes something a test can assert
 * on rather than something a comment claims.
 *
 * Scope is deliberately the default. The ledger has to outlive every request to
 * be able to compare across them, and it is the one provider in this module
 * whose scope is not part of the lesson — if it were request-scoped it would be
 * rebuilt alongside the things it is meant to be counting and would report `1`
 * for everything, forever.
 *
 * The tally is in memory and per process, which is the right shape for a
 * teaching aid and the wrong shape for anything else: a second replica keeps
 * its own, and a restart forgets. Nothing outside `src/di-scopes` depends on it.
 */
@Injectable()
export class InstantiationLedger {
  private readonly counts = new Map<string, number>();

  private readonly recent = new Map<string, string[]>();

  private nextOrdinal = 0;

  /**
   * Records one construction of `provider` and returns the new instance's id.
   *
   * Ids come from a single sequence shared by every provider, so they also
   * order constructions against each other: `RequestContextService#7` was built
   * before `AuditTrailService#8`, which is what makes the per-request build
   * order legible in a test failure.
   */
  record(provider: string): string {
    this.nextOrdinal += 1;
    const instanceId = `${provider}#${this.nextOrdinal}`;

    this.counts.set(provider, (this.counts.get(provider) ?? 0) + 1);

    const ids = this.recent.get(provider);
    if (!ids) {
      this.recent.set(provider, [instanceId]);
    } else {
      ids.push(instanceId);
      if (ids.length > RECENT_INSTANCE_IDS) ids.shift();
    }

    return instanceId;
  }

  /** How many instances of `provider` have been constructed. */
  countFor(provider: string): number {
    return this.counts.get(provider) ?? 0;
  }

  recentInstanceIdsFor(provider: string): readonly string[] {
    return [...(this.recent.get(provider) ?? [])];
  }

  entryFor(provider: string): LedgerEntry {
    return {
      constructions: this.countFor(provider),
      recentInstanceIds: this.recentInstanceIdsFor(provider),
    };
  }

  /** Every provider that has recorded at least one construction. */
  snapshot(): Readonly<Record<string, LedgerEntry>> {
    const snapshot: Record<string, LedgerEntry> = {};
    for (const provider of this.counts.keys()) {
      snapshot[provider] = this.entryFor(provider);
    }
    return snapshot;
  }

  /**
   * Forgets everything recorded so far.
   *
   * Exists for tests that need a clean baseline inside one running
   * application. It destroys no instance — a provider constructed before a
   * reset is still alive and still injected wherever it was injected; only the
   * record of its construction is gone.
   */
  reset(): void {
    this.counts.clear();
    this.recent.clear();
    this.nextOrdinal = 0;
  }
}
