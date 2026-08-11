import { Inject, Injectable, Optional } from "@nestjs/common";
import { createHash } from "node:crypto";
import { InstantiationLedger } from "./instantiation-ledger.service";
import { ScopedLogger } from "./scoped-logger.service";

/** A percentage rollout, keyed by flag name. `0` is off for everyone, `100` on for everyone. */
export type FlagRollout = Readonly<Record<string, number>>;

/**
 * Optional override for the flag table. Left unbound by `DiScopesModule`, so a
 * deployment that does not need its own flags gets {@link DEFAULT_FLAGS} and
 * the token never has to exist — the same shape `S3_CLIENT_OPTIONS` uses.
 */
export const FEATURE_FLAGS = Symbol("FEATURE_FLAGS");

export const DEFAULT_FLAGS: FlagRollout = {
  "checkout.express": 100,
  "search.semantic": 25,
  "profile.avatar-crop": 0,
};

/**
 * A singleton whose usefulness *is* its lifetime.
 *
 * `Scope.DEFAULT` is not written out below, because leaving it off is how a
 * default-scoped provider is normally declared and this class should look like
 * the hundred other providers in a codebase. Every one of them is affected by
 * the same rule: Nest constructs it once, during `app.init()`, and every
 * consumer shares that instance for the lifetime of the process.
 *
 * Two things here depend on that and would be quietly lost if this provider
 * ever inherited request scope — see [docs/di-scopes.md](../../docs/di-scopes.md):
 *
 * 1. The flag table is parsed once at construction. Per request, that parse
 *    moves onto the request's own latency budget.
 * 2. `evaluations` memoises the bucket hash per `flag:subject`. Per request,
 *    the memo starts empty every time, so it never returns a hit for a real
 *    client and is pure overhead — a cache that is *colder* than no cache.
 *
 * The class has no way to notice this happening to it. Nothing in its own file
 * changes; a provider it does not import acquires a request-scoped dependency,
 * and this becomes per-request too.
 */
@Injectable()
export class FeatureFlagCache {
  readonly instanceId: string;

  /** Resolved rollouts, parsed once. */
  private readonly rollouts: ReadonlyMap<string, number>;

  private readonly evaluations = new Map<string, boolean>();

  private hits = 0;

  private misses = 0;

  constructor(
    ledger: InstantiationLedger,
    private readonly logger: ScopedLogger,
    @Optional() @Inject(FEATURE_FLAGS) flags?: FlagRollout,
  ) {
    this.instanceId = ledger.record(FeatureFlagCache.name);
    this.rollouts = new Map(
      Object.entries(flags ?? DEFAULT_FLAGS).map(([flag, percent]) => [
        flag,
        clampPercent(percent),
      ]),
    );
    this.logger.debug(`Loaded ${this.rollouts.size} feature flag(s) as ${this.instanceId}`);
  }

  /**
   * Whether `flag` is on for `subject`, memoised.
   *
   * An unknown flag is off. That is the safe direction for a rollout: a typo
   * in a flag name should leave everybody on the old path, not put everybody
   * on the new one.
   */
  isEnabled(flag: string, subject: string): boolean {
    const key = `${flag}:${subject}`;
    const memoised = this.evaluations.get(key);
    if (memoised !== undefined) {
      this.hits += 1;
      return memoised;
    }

    this.misses += 1;
    const percent = this.rollouts.get(flag) ?? 0;
    const enabled = percent > 0 && bucketOf(key) < percent;
    this.evaluations.set(key, enabled);
    return enabled;
  }

  /** Memo statistics, for asserting that the memo is actually being reused. */
  stats(): { readonly hits: number; readonly misses: number; readonly memoised: number } {
    return { hits: this.hits, misses: this.misses, memoised: this.evaluations.size };
  }

  /** The logger's host name, exposed so the transient wiring can be asserted on. */
  loggerHost(): string {
    return this.logger.host;
  }
}

function clampPercent(percent: number): number {
  if (!Number.isFinite(percent)) return 0;
  return Math.min(100, Math.max(0, Math.trunc(percent)));
}

/**
 * A stable bucket in `[0, 100)` for a flag/subject pair.
 *
 * Hashed rather than random so that a subject stays on the same side of a
 * rollout across processes and restarts, and so the memo above is an
 * optimisation rather than the thing that makes results consistent.
 */
function bucketOf(key: string): number {
  const digest = createHash("sha256").update(key).digest();
  return digest.readUInt16BE(0) % 100;
}
