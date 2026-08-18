export { DISTRIBUTED_LOCK, DISTRIBUTED_LOCK_NAMES } from "./distributed-lock.port";
export type {
  DistributedLock,
  DistributedLockName,
  LockAcquireOptions,
  LockHandle,
  LockLogger,
} from "./distributed-lock.port";
export { SystemLockClock } from "./lock-clock.port";
export type { LockClock, LockRandom } from "./lock-clock.port";
