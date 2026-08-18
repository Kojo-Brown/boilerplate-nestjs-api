export { lockRows } from "./row-lock";
export type { RawQueryExecutor, RowLockSpec, RowLockStrength, RowLockWaitPolicy } from "./row-lock";
export {
  DeadlockDetectedError,
  LockLostError,
  LockNotAcquiredError,
  LockUnavailableError,
} from "./locking.errors";

export { DISTRIBUTED_LOCK, DISTRIBUTED_LOCK_NAMES, SystemLockClock } from "./ports";
export type {
  DistributedLock,
  DistributedLockName,
  LockAcquireOptions,
  LockClock,
  LockHandle,
  LockLogger,
  LockRandom,
} from "./ports";

export { RedlockService, RedlockAcquisitionError } from "./redlock.service";
export type { RedlockOptions } from "./redlock.service";
export { InMemoryDistributedLock } from "./in-memory-distributed-lock";
export { currentLock, withLock } from "./lock-session";
export type { CurrentLock, WithLockOptions } from "./lock-session";
export { LockingModule, createDistributedLock } from "./locking.module";
