/**
 * One Redis logical database per suite that talks to a real server.
 *
 * Every one of those suites clears up with `FLUSHDB`, which is the only
 * honest way to reset a server between tests — it knows nothing about key
 * prefixes, so two suites sharing a database wipe each other's keys. Jest runs
 * *files* in parallel workers, so "sharing a database" means "deleting the
 * other suite's state in the middle of one of its tests", intermittently, on
 * whichever CI leg happened to overlap.
 *
 * That has now happened twice, and both times the file that moved reasoned
 * only about the suites it knew of: `idempotency-store.contract.spec.ts` took
 * db 15, `redis-idempotency.store.spec.ts` moved to db 14 to keep off it, and
 * `distributed-lock.contract.spec.ts` then also took db 14 — leaving the
 * Redlock fencing counter to be deleted mid-test by a suite in another
 * directory. The second collision is exactly the shape of the first, because
 * a comment saying which databases a file avoids is a claim that no future
 * file can read.
 *
 * So the allocation lives here instead, as one object. A new suite adds a
 * field and gets a database nothing else uses; a duplicate is visible in a
 * single screenful rather than spread across three directories. Redis serves
 * databases 0–15 by default, which is the ceiling on how far this scales — if
 * it is ever reached, the answer is a server per suite, not a shared one.
 *
 * db 0 is deliberately absent: it is what a developer's local cache and
 * BullMQ use, and a suite that flushed it would delete the data of whatever
 * they were running at the time.
 */
export const REDIS_TEST_DATABASES = {
  /** `src/common/idempotency/idempotency-store.contract.spec.ts` */
  idempotencyContract: 15,
  /** `src/common/locking/distributed-lock.contract.spec.ts` */
  distributedLockContract: 14,
  /** `src/common/idempotency/stores/redis-idempotency.store.spec.ts` */
  redisIdempotencyStore: 13,
} as const;
