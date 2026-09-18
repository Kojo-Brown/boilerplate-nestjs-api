import DataLoader from "dataloader";

/**
 * A loader that resolves entities by key, coalescing every key asked for in one
 * tick into a single batch read.
 *
 * `null` rather than a rejection for a key nothing matches: a missing row is an
 * ordinary answer here — a saga pruned out from under an order that still names
 * it — and `DataLoader` reserves rejection for a batch that genuinely failed.
 */
export type EntityLoader<K, V> = DataLoader<K, V | null>;

export interface EntityLoaderOptions<K, V> {
  /**
   * Reads every entity for `keys`, in one round trip.
   *
   * Free to return them in any order, to omit the ones that do not exist, and
   * to collapse duplicates — {@link createEntityLoader} realigns whatever comes
   * back. That is the whole reason this wrapper exists; see the note there.
   */
  readonly load: (keys: readonly K[]) => Promise<readonly V[]>;
  /** The key an entity answers to, used to match results back to the keys asked for. */
  readonly identify: (entity: V) => K;
  /**
   * Split a batch larger than this into several reads. Unset means no ceiling.
   *
   * Worth setting where the underlying read is an `IN (…)` list: a page of
   * twenty is one statement either way, but a batch of ten thousand keys is a
   * query plan nobody wants and, on some drivers, a parameter-limit error.
   */
  readonly maxBatchSize?: number;
}

/**
 * A `DataLoader` over a batch read, with the two contract details that a
 * hand-rolled batch function almost always gets wrong.
 *
 * **Results must line up with keys.** `DataLoader` matches by position: the
 * array a batch function returns has to have exactly one entry per key, in the
 * order the keys were given. Repository batch reads do not work that way — they
 * return the rows that exist, in whatever order the database found them — so
 * handing `store.findMany(ids)` straight to `new DataLoader()` mismatches every
 * key as soon as one row is missing, silently pairing entities with the wrong
 * keys. This indexes the result and rebuilds the array against the keys.
 *
 * **A miss is not an error.** `DataLoader` treats an `Error` *value* in the
 * returned array as a rejection for that key, which is the documented way to
 * report "no such entity" — and the wrong one for a relation that is legitimately
 * optional, because it turns an ordinary empty field into a failed request.
 * Misses resolve `null`.
 *
 * ## Lifetime
 *
 * A loader caches every key it has resolved, so it must not outlive the
 * operation that created it: a longer-lived one hands back rows read before the
 * write that changed them, and — worse for anything user-scoped — hands one
 * request's rows to another request that asks for the same id. Create one per
 * operation, from a singleton factory such as `SagaLoaders`, and let it be
 * collected with the request. That is also why this file exposes no module-level
 * loader to import.
 *
 * Within that lifetime the cache is deliberately on: a page of twenty orders
 * placed in one checkout session shares saga ids, and the second order that
 * names a saga already loaded should not queue a second key for it.
 *
 * A failed batch rejects every key in it, and that rejection is cached for the
 * rest of the operation — correct here, since the operation is failing anyway
 * and a retry inside it would be a second chance nobody asked for.
 */
export function createEntityLoader<K, V>(options: EntityLoaderOptions<K, V>): EntityLoader<K, V> {
  const { load, identify, maxBatchSize } = options;

  return new DataLoader<K, V | null>(
    async (keys) => {
      const entities = await load(keys);
      const byKey = new Map<K, V>();
      for (const entity of entities) byKey.set(identify(entity), entity);
      return keys.map((key) => byKey.get(key) ?? null);
    },
    maxBatchSize === undefined ? {} : { maxBatchSize },
  );
}
