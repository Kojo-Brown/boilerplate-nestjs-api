import { Logger } from "@nestjs/common";
import {
  describeKeyMaterial,
  loadKeyMaterial,
  millisecondsUntilExpiry,
  KeyMaterialError,
} from "./key-material";
import type { KeyMaterial, KeyMaterialFiles } from "./key-material";

/**
 * Holds the current key material and replaces it when the files on disk change.
 *
 * **Why this exists at all.** A certificate is the one input to a running
 * service that is guaranteed to stop working. Everything else fails when
 * something changes; this fails when nothing does. A service that reads its
 * material once at boot has to be restarted to pick up a rotation, which is
 * fine until the rotation is the emergency one — a revoked CA at two in the
 * morning, with the rollout of every replica in the way.
 *
 * **Why it polls instead of watching.** `fs.watch` on the certificate path is
 * the obvious implementation and it does not work where this runs. Kubernetes
 * updates a mounted secret by writing a new timestamped directory and swapping
 * the `..data` symlink; the file the watch is holding is never written to, so
 * no event arrives — and the inode it points at still has the old certificate
 * in it. Re-reading the path is what sees the swap. The read is three small
 * files every few minutes, against material that changes hourly at most.
 *
 * **Why a failed reload keeps the old material.** The files are not written
 * atomically together. There is a window — short in a mesh, long in a hand-run
 * `scp` — where the certificate is the new one and the key is still the old,
 * and loading that pair produces something OpenSSL will not build a context
 * from. Swapping it in would turn a rotation into an outage; the previous
 * material is still valid, so the reload logs, keeps it, and tries again on the
 * next tick.
 */
export class MtlsKeyMaterialService {
  private readonly logger: MtlsLogger;
  private material: KeyMaterial | null = null;
  private reloadTimer: CancellableInterval | null = null;
  private readonly listeners = new Set<(material: KeyMaterial) => void>();

  constructor(private readonly options: MtlsKeyMaterialOptions) {
    this.logger = options.logger ?? new Logger(MtlsKeyMaterialService.name);
  }

  /**
   * Loads the material and starts the reload timer.
   *
   * Throws {@link KeyMaterialError} if the first load fails: a service that
   * cannot present a certificate cannot serve a single request, and failing
   * here is how that is discovered by the deployment rather than by its callers.
   */
  start(): KeyMaterial {
    const material = loadKeyMaterial(this.options.files, {
      now: this.options.now(),
      ...(this.options.passphrase === undefined ? {} : { passphrase: this.options.passphrase }),
    });
    this.material = material;
    this.logger.log(`mTLS material loaded: ${describeKeyMaterial(material)}`);
    this.warnIfExpiringSoon(material);

    const interval = this.options.reloadIntervalMs;
    if (interval > 0) {
      const scheduler = this.options.scheduler ?? nodeReloadScheduler;
      this.reloadTimer = scheduler.every(interval, () => this.reload());
    }

    return material;
  }

  /** The material in use. Throws if {@link start} has not run. */
  current(): KeyMaterial {
    if (this.material === null) {
      throw new KeyMaterialError(
        "mTLS key material was requested before it was loaded. start() must run before the " +
          "server or any peer dispatcher is built from it.",
      );
    }
    return this.material;
  }

  /** The material in use, or `null` before the first load. */
  peek(): KeyMaterial | null {
    return this.material;
  }

  /**
   * Re-reads the files, swapping the material in if it parsed and changed.
   *
   * Returns what happened, so the timer's caller and a test can tell a rotation
   * from a no-op from a failure without reading the log.
   */
  reload(): ReloadOutcome {
    const previous = this.material;
    let next: KeyMaterial;

    try {
      next = loadKeyMaterial(this.options.files, {
        now: this.options.now(),
        ...(this.options.passphrase === undefined ? {} : { passphrase: this.options.passphrase }),
      });
    } catch (cause) {
      this.logger.error(
        `mTLS material reload failed; keeping the material loaded at startup. ` +
          `${cause instanceof Error ? cause.message : String(cause)}`,
      );
      return "failed";
    }

    if (previous !== null && previous.fingerprint === next.fingerprint) {
      this.warnIfExpiringSoon(next);
      return "unchanged";
    }

    this.material = next;
    this.logger.log(
      `mTLS material rotated: ${describeKeyMaterial(next)}` +
        (previous === null ? "" : ` (was fingerprint=${previous.fingerprint})`),
    );
    this.warnIfExpiringSoon(next);
    this.notify(next);
    return "rotated";
  }

  /**
   * Registers a listener for rotations, and returns the function that removes
   * it.
   *
   * Listeners are what rebuild the things that took a *copy* of the material —
   * the server's secure context and the outbound dispatchers. Both are built
   * from the PEM at construction time and neither re-reads it, so without this
   * a rotation would change the material and nothing else.
   */
  onRotate(listener: (material: KeyMaterial) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Stops the reload timer. Safe to call twice. */
  stop(): void {
    this.reloadTimer?.cancel();
    this.reloadTimer = null;
    this.listeners.clear();
  }

  private notify(material: KeyMaterial): void {
    for (const listener of this.listeners) {
      try {
        listener(material);
      } catch (cause) {
        // One listener failing must not strand the others: the dispatchers not
        // being rebuilt is a bad afternoon, the server not being rebuilt is an
        // outage at the next expiry.
        this.logger.error(
          `An mTLS rotation listener threw. ${cause instanceof Error ? cause.stack : String(cause)}`,
        );
      }
    }
  }

  private warnIfExpiringSoon(material: KeyMaterial): void {
    const days = this.options.expiryWarningDays;
    if (days <= 0) return;

    const remainingMs = millisecondsUntilExpiry(material, this.options.now());
    if (remainingMs > days * DAY_MS) return;

    this.logger.warn(
      `mTLS material expires in ${(remainingMs / DAY_MS).toFixed(1)} days ` +
        `(${material.expiresAt.toISOString()}). Every peer stops talking to this service at ` +
        `that moment, in both directions. ${describeKeyMaterial(material)}`,
    );
  }
}

/** What a reload did. */
export type ReloadOutcome = "rotated" | "unchanged" | "failed";

export interface MtlsKeyMaterialOptions {
  readonly files: KeyMaterialFiles;
  readonly passphrase?: string;
  /** `0` disables the reload timer. */
  readonly reloadIntervalMs: number;
  readonly expiryWarningDays: number;
  /** Injected so a suite can move the clock rather than wait for one. */
  readonly now: () => Date;
  /**
   * Injected for the same reason: a suite fires the reload itself rather than
   * waiting five minutes for a timer. Defaults to {@link nodeReloadScheduler}.
   */
  readonly scheduler?: ReloadScheduler;
  readonly logger?: MtlsLogger;
}

/**
 * The logging surface this module uses.
 *
 * A `Pick` of Nest's `Logger` rather than the class itself, so a spec can pass
 * three functions and assert on what was written — a rotation that keeps the
 * old material is a decision whose only outward sign is a log line, and a test
 * that cannot read it is not testing the decision.
 */
export type MtlsLogger = Pick<Logger, "log" | "warn" | "error">;

/** A timer that has been started and can be stopped. */
export interface CancellableInterval {
  cancel(): void;
}

/** How the reload is scheduled. One method, so a test can substitute a queue. */
export interface ReloadScheduler {
  every(ms: number, callback: () => void): CancellableInterval;
}

/**
 * The real timer.
 *
 * `unref`ed: polling for a rotation is not a reason to keep the process alive,
 * and a Jest worker that outlives its suite because of a certificate poll is a
 * hang with no error message.
 */
export const nodeReloadScheduler: ReloadScheduler = {
  every(ms, callback) {
    const timer = setInterval(callback, ms);
    timer.unref();
    return { cancel: () => clearInterval(timer) };
  },
};

const DAY_MS = 86_400_000;
