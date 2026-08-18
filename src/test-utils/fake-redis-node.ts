import type { Redis } from "ioredis";
import type { LockClock } from "@/common/locking";

/**
 * One Redis node, as `RedlockService` uses one.
 *
 * The contract suite runs against real `redis-server` processes because that is
 * the only way to certify the Lua and the expiry semantics. This exists for the
 * other half: the quorum arithmetic, which needs a node that is *down*, a node
 * that never answers, and counters that have deliberately drifted apart —
 * states a real server does not enter on request.
 *
 * The four methods reimplement the four scripts in `redlock.service.ts`. That
 * duplication is the point of keeping the contract suite on real servers: if
 * this drifts from the Lua, the contract catches it.
 */
export class FakeRedisNode {
  private readonly keys = new Map<string, { value: string; expiresAt: number }>();

  /** The node's fencing counter, readable and settable so drift can be staged. */
  fence = 0;

  /** Every command rejects, as against a node that is down. */
  down = false;

  /** Every command hangs, as against a node that accepted the connection and went quiet. */
  silent = false;

  /** Set to make `redlockBumpFence` refuse, so a failed publish can be staged. */
  refuseBump = false;

  /** Advances the shared clock by this much on every command, to stage a slow round trip. */
  latencyMs = 0;

  readonly calls: string[] = [];

  constructor(private readonly clock: LockClock) {}

  /** `RedlockService` installs its scripts through this; there is nothing to install here. */
  defineCommand(): void {}

  /** Part of the shutdown path `RedlockService.onModuleDestroy` walks. */
  async quit(): Promise<"OK"> {
    this.calls.push("quit");
    return "OK";
  }

  disconnect(): void {
    this.calls.push("disconnect");
  }

  async redlockAcquire(
    lockKey: string,
    fenceKey: string,
    value: string,
    ttlMs: string,
  ): Promise<number> {
    await this.begin("acquire");
    const existing = this.keys.get(lockKey);
    if (existing && existing.expiresAt > this.clock.now()) return -1;

    this.keys.set(lockKey, { value, expiresAt: this.clock.now() + Number(ttlMs) });
    void fenceKey;
    this.fence += 1;
    return this.fence;
  }

  async redlockBumpFence(_fenceKey: string, token: string): Promise<number> {
    await this.begin("bump");
    if (this.refuseBump) return 0;
    this.fence = Math.max(this.fence, Number(token));
    return 1;
  }

  async redlockRelease(lockKey: string, value: string): Promise<number> {
    await this.begin("release");
    if (!this.holds(lockKey, value)) return 0;
    this.keys.delete(lockKey);
    return 1;
  }

  async redlockExtend(lockKey: string, value: string, ttlMs: string): Promise<number> {
    await this.begin("extend");
    if (!this.holds(lockKey, value)) return 0;
    this.keys.set(lockKey, { value, expiresAt: this.clock.now() + Number(ttlMs) });
    return 1;
  }

  /** Whether the node currently carries a live lock under `lockKey`. */
  isHeld(lockKey: string): boolean {
    const entry = this.keys.get(lockKey);
    return entry !== undefined && entry.expiresAt > this.clock.now();
  }

  /** Hands the node to `RedlockService`, which only ever calls the five methods above. */
  asRedis(): Redis {
    return this as unknown as Redis;
  }

  private async begin(call: string): Promise<void> {
    this.calls.push(call);
    if (this.latencyMs > 0)
      (this.clock as { advance?: (ms: number) => void }).advance?.(this.latencyMs);
    if (this.silent) await new Promise(() => {});
    if (this.down) throw new Error("connection refused");
  }

  private holds(lockKey: string, value: string): boolean {
    const entry = this.keys.get(lockKey);
    return entry !== undefined && entry.value === value && entry.expiresAt > this.clock.now();
  }
}
