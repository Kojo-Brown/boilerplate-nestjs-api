import { Inject, Injectable } from "@nestjs/common";
import { createEntityLoader } from "@/common/dataloader";
import type { EntityLoader } from "@/common/dataloader";
import type { SagaInstanceRecord } from "./saga-instance";
import { SAGA_STORE, type SagaStore } from "./ports";

/** A loader that resolves saga instances by id, one batch per tick. */
export type SagaLoader = EntityLoader<string, SagaInstanceRecord>;

/**
 * Makes saga loaders. One per operation — never one to share.
 *
 * The factory is a singleton and the loaders it makes are not, and that split is
 * the whole design. A `DataLoader` is two things at once: a batching window,
 * which is what the read path wants, and a cache, which has to expire. Nest
 * offers `Scope.REQUEST` for exactly this, and `docs/di-scopes.md` explains why
 * it is the wrong reach here: the scope propagates up the injection graph, so a
 * request-scoped loader would make `ListOrdersHandler` request-scoped too, and
 * `QueryBus` resolves its handlers once at bootstrap.
 *
 * Creating the loader inside the operation gets the batching with no scope at
 * all, and gives the cache the only lifetime that is certainly safe: shorter
 * than the request. A loader held on a singleton would answer with rows read
 * before the write that changed them, and would hand one caller's saga to the
 * next caller who names the same id — a page of orders is per-customer, so that
 * is a cross-account read, not a stale render.
 *
 * ```ts
 * const sagas = this.loaders.byId();
 * const views = await Promise.all(
 *   orders.map(async (order) => toOrderView(order, await sagas.load(order.sagaId), registry)),
 * );
 * ```
 *
 * The `await` inside the `map` is what makes it read like an N+1 and is not
 * one: every `load` is queued in the same tick, and the loader turns them into
 * a single `findMany`. Keeping that shape matters — the alternative is a
 * two-phase collect-ids-then-zip, which is the same query count written so that
 * nothing else can be read alongside it.
 */
@Injectable()
export class SagaLoaders {
  constructor(@Inject(SAGA_STORE) private readonly store: SagaStore) {}

  /**
   * A fresh loader for one operation.
   *
   * No `maxBatchSize`: every caller today loads at most one page of ids, which
   * `ListOrdersQueryDto` caps well below anything Postgres minds in an `IN`
   * list. A caller that loads an unbounded set should pass one rather than
   * discover the parameter limit in production.
   */
  byId(): SagaLoader {
    return createEntityLoader({
      load: (ids) => this.store.findMany(ids),
      identify: (instance) => instance.id,
    });
  }
}
