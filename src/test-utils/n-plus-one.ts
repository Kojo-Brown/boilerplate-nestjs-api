/**
 * Detecting N+1 reads in a test, rather than in a dashboard.
 *
 * An N+1 is not a slow query, which is why nothing about a single run reveals
 * it: one order read plus one saga read is a perfectly ordinary page, and so is
 * twenty plus twenty. What distinguishes the bug is *growth* — the read count
 * moves with the size of the result — so the detector here runs the same
 * operation over several sizes and reports what the count did.
 *
 * Two levels use it, and neither replaces the other:
 *
 * - The unit level, here, counts calls into a repository port through
 *   {@link recordCalls}. It runs in milliseconds on every push and catches the
 *   shape of the bug.
 * - `test/orders-read.db-spec.ts` counts Prisma operations against a real
 *   Postgres, which is the level that cannot be fooled by a double whose
 *   `findMany` happens to loop.
 */

/** Every method call seen on a recorded object, in order. */
export interface CallRecorder {
  /** `"SagaStore.findMany"`, oldest first. */
  readonly calls: readonly string[];
  /** How many calls match, by exact name or pattern. All of them when omitted. */
  count(match?: string | RegExp): number;
  /** Forgets everything recorded so far. */
  reset(): void;
}

/**
 * Wraps an object so every method call on it is recorded, and returns both.
 *
 * A proxy rather than a hand-written spy per port, because the point is to
 * count *whatever* the subject asks for: a spy written against today's
 * interface would quietly stop counting the day a handler starts calling
 * something else.
 *
 * Only method calls are recorded; property reads pass through untouched.
 */
export function recordCalls<T extends object>(
  subject: T,
  label: string,
): { readonly subject: T; readonly recorder: CallRecorder } {
  const calls: string[] = [];

  const proxy = new Proxy(subject, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver) as unknown;
      if (typeof value !== "function" || typeof property === "symbol") return value;

      const method = value as (...args: unknown[]) => unknown;
      return (...args: unknown[]): unknown => {
        calls.push(`${label}.${property}`);
        // Applied to the target rather than to the proxy: a store whose method
        // calls another of its own methods would otherwise be counted twice,
        // and a caller reading the count would see an N+1 in the recorder.
        return method.apply(target, args);
      };
    },
  });

  const recorder: CallRecorder = {
    get calls() {
      return calls;
    },
    count(match) {
      if (match === undefined) return calls.length;
      if (typeof match === "string") return calls.filter((call) => call === match).length;
      return calls.filter((call) => match.test(call)).length;
    },
    reset() {
      calls.length = 0;
    },
  };

  return { subject: proxy, recorder };
}

export interface QueryGrowthOptions {
  /**
   * The result sizes to run at, smallest first.
   *
   * At least two, and worth making the largest several times the smallest: a
   * batch read that is accidentally chunked would hold steady from 1 to 2 and
   * give itself away at 20.
   */
  readonly sizes: readonly number[];
  /** Where the counts come from. Several when one operation touches several ports. */
  readonly recorders: readonly CallRecorder[];
  /** Runs the operation over a result of `size`. Seeding is the caller's job. */
  readonly run: (size: number) => Promise<unknown>;
}

export interface QueryGrowth {
  /** Total reads recorded at each size, keyed by that size. */
  readonly countsBySize: Readonly<Record<number, number>>;
  /** What was called at each size, for a failure message that names the culprit. */
  readonly callsBySize: Readonly<Record<number, readonly string[]>>;
  /** True when the count never moved — the property a batched read has and an N+1 does not. */
  readonly constant: boolean;
}

/**
 * Runs one operation at several result sizes and reports how the read count
 * moved.
 *
 * Assert on {@link QueryGrowth.countsBySize} rather than only on `constant`:
 * a spec that pins the exact number also fails when a batched read turns into
 * two batched reads, which `constant` alone would call a pass.
 *
 * The recorders are reset before each run, so the counts are per-operation
 * rather than cumulative.
 */
export async function measureQueryGrowth(options: QueryGrowthOptions): Promise<QueryGrowth> {
  const { sizes, recorders, run } = options;
  if (sizes.length < 2) {
    throw new Error("measureQueryGrowth needs at least two sizes: one size cannot show growth.");
  }

  const countsBySize: Record<number, number> = {};
  const callsBySize: Record<number, readonly string[]> = {};

  for (const size of sizes) {
    for (const recorder of recorders) recorder.reset();
    await run(size);
    countsBySize[size] = recorders.reduce((total, recorder) => total + recorder.count(), 0);
    callsBySize[size] = recorders.flatMap((recorder) => [...recorder.calls]);
  }

  const counts = sizes.map((size) => countsBySize[size]);
  return {
    countsBySize,
    callsBySize,
    constant: counts.every((count) => count === counts[0]),
  };
}
