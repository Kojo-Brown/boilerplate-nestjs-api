import { Inject, Injectable, Logger, Optional } from "@nestjs/common";
import type { OnModuleInit } from "@nestjs/common";
import { DiscoveryService, MetadataScanner } from "@nestjs/core";
import type { InstanceWrapper } from "@nestjs/core/injector/instance-wrapper";
import { DISTRIBUTED_LOCK, SystemLockClock } from "@/common/locking";
import type { DistributedLock } from "@/common/locking";
import {
  CACHEABLE_METADATA,
  LOCK_METADATA,
  RETRY_METADATA,
  TIMED_METADATA,
  hasAspectMetadata,
  readAspectMetadata,
} from "./aspect.metadata";
import { AspectConfigurationError } from "./aspect.types";
import type { AspectContext, AspectInvocation } from "./aspect.types";
import { applyLock } from "./lock.aspect";
import type { ResolvedLockOptions } from "./lock.aspect";
import { applyCacheable } from "./cacheable.aspect";
import type { ResolvedCacheableOptions } from "./cacheable.aspect";
import { applyRetry } from "./retry.aspect";
import type { ResolvedRetryOptions } from "./retry.aspect";
import { applyTiming } from "./timed.aspect";
import type { ResolvedTimedOptions } from "./timed.aspect";
import { ASPECT_CACHE, ASPECT_CLOCK, ASPECT_RANDOM, METHOD_TIMING_RECORDER } from "./ports";
import type { AspectCacheStore, AspectClock, AspectRandom, MethodTimingRecorder } from "./ports";

/** Set on every installed wrapper so a second weave cannot stack a second copy. */
const WOVEN = Symbol("aspect:woven");

export type WeaveSkipReason = "controller" | "non-singleton";

export interface WeaveSkip {
  readonly target: string;
  readonly method: string;
  readonly reason: WeaveSkipReason;
  /** Whether `@Lock()` is among the decorators that will not take effect. */
  readonly lock: boolean;
}

export interface WeaveReport {
  /** `Class.method` for every method that received an aspect chain. */
  readonly woven: string[];
  /** Methods carrying aspect metadata that could not be wrapped, and why. */
  readonly skipped: WeaveSkip[];
}

type UnknownMethod = (...args: unknown[]) => unknown;

/**
 * Installs the behaviour behind `@Cacheable()`, `@Retry()` and `@Timed()`.
 *
 * The decorators only write metadata; this reads it back once the container is
 * up and replaces each decorated method with a chain that closes over the
 * injected cache, clock and recorder. That indirection is the whole reason the
 * pattern works in a DI container: a decorator runs while the class body is
 * being evaluated, long before any provider exists to be injected into it.
 *
 * ## Why only singleton providers
 *
 * Weaving happens in `onModuleInit`, and `NestApplication.init()` runs
 * `registerRouter()` before `callInitHook()`. By then the router has already
 * captured each controller's handler, so replacing a controller method here
 * would change nothing an HTTP request goes through — the aspect would look
 * applied and silently do nothing. Request- and transient-scoped providers have
 * the opposite problem: their instances do not exist yet at init.
 *
 * Both cases are reported at `warn` rather than ignored, because a
 * cross-cutting concern that quietly does not apply is worse than one that is
 * absent. For controllers, keep the work in a provider and let the controller
 * delegate; for HTTP response caching, `HttpCacheInterceptor` already exists.
 */
@Injectable()
export class AspectWeaver implements OnModuleInit {
  private readonly logger = new Logger(AspectWeaver.name);
  private readonly cacheableLogger = new Logger("Cacheable");
  private readonly retryLogger = new Logger("Retry");
  private readonly timedLogger = new Logger("Timed");
  private readonly lockLogger = new Logger("Lock");
  /**
   * `@Lock()` measures leases against a monotonic clock, which `ASPECT_CLOCK`
   * (`Date.now()`) is not — see `LockClock`. It is not injected because there
   * is nothing to configure: a test drives `applyLock` directly with a fake.
   */
  private readonly lockClock = new SystemLockClock();

  constructor(
    private readonly discovery: DiscoveryService,
    private readonly scanner: MetadataScanner,
    @Inject(ASPECT_CACHE) private readonly cache: AspectCacheStore,
    @Inject(ASPECT_CLOCK) private readonly clock: AspectClock,
    @Inject(ASPECT_RANDOM) private readonly random: AspectRandom,
    @Inject(METHOD_TIMING_RECORDER) private readonly recorder: MethodTimingRecorder,
    /**
     * Optional so an application that uses none of the locking features does
     * not have to bind one — but a `@Lock()` found without it is a boot
     * failure, not a warning. There is no safe way to run a method that asked
     * for mutual exclusion without any.
     */
    @Optional() @Inject(DISTRIBUTED_LOCK) private readonly distributedLock?: DistributedLock,
  ) {}

  onModuleInit(): void {
    this.weave();
  }

  /** Exposed so tests can assert on what was and was not wrapped. */
  weave(): WeaveReport {
    const report: WeaveReport = { woven: [], skipped: [] };

    for (const wrapper of this.discovery.getControllers()) {
      this.collectSkips(wrapper, "controller", report);
    }

    const visited = new Set<object>();
    for (const wrapper of this.discovery.getProviders()) {
      const prototype = prototypeOf(wrapper);
      if (!prototype) continue;

      // Nest keeps a `Object.create(prototype)` placeholder in the static
      // context for non-singleton providers, so the presence of an instance
      // proves nothing: what a consumer actually receives is a per-request or
      // per-injection clone made after this runs, which would not carry the
      // wrapper. `isDependencyTreeStatic()` also catches a DEFAULT-scoped
      // provider that inherits request scope from one of its dependencies.
      if (!wrapper.isDependencyTreeStatic() || wrapper.isTransient) {
        this.collectSkips(wrapper, "non-singleton", report);
        continue;
      }

      const instance = wrapper.instance as object | null | undefined;
      if (!instance || typeof instance !== "object") continue;
      if (visited.has(instance)) continue;
      visited.add(instance);

      this.weaveInstance(instance, prototype, nameOf(wrapper), report);
    }

    for (const skip of report.skipped) {
      this.logger.warn(
        `${skip.target}.${skip.method}() carries an aspect decorator that has no effect: ` +
          (skip.reason === "controller"
            ? "controller handlers are bound to the router before onModuleInit, so move the work into a provider."
            : "the provider is request- or transient-scoped, so its instances are created after weaving."),
      );
    }

    // Every other aspect degrades into an absence — no cache, no retries, no
    // timing sample. `@Lock()` degrades into a method that runs without the
    // mutual exclusion it was written to assume, which nothing downstream can
    // detect. A skipped one is therefore refused at boot rather than logged.
    const unlockable = report.skipped.filter((skip) => skip.lock);
    if (unlockable.length > 0) {
      throw new AspectConfigurationError(
        `@Lock() cannot be installed on ${unlockable
          .map((skip) => `${skip.target}.${skip.method}()`)
          .join(", ")} — ` +
          "a controller handler is bound to the router before weaving, and a request- or " +
          "transient-scoped provider is instantiated after it. Move the work into a singleton " +
          "provider, or call withLock() directly.",
      );
    }
    if (report.woven.length > 0) {
      this.logger.log(`Wove aspects into ${report.woven.length} method(s)`);
    }

    return report;
  }

  private weaveInstance(
    instance: object,
    prototype: object,
    target: string,
    report: WeaveReport,
  ): void {
    for (const method of this.scanner.getAllMethodNames(prototype)) {
      if (!hasAspectMetadata(prototype, method)) continue;

      const original = (instance as Record<string, unknown>)[method];
      if (typeof original !== "function") continue;
      if ((original as { [WOVEN]?: true })[WOVEN]) continue;

      const context: AspectContext = { target, method };
      const woven = this.buildChain(instance, original as UnknownMethod, context, prototype);

      Object.defineProperty(instance, method, {
        value: woven,
        writable: true,
        configurable: true,
        enumerable: false,
      });
      report.woven.push(`${target}.${method}`);
    }
  }

  /**
   * Outermost first: `@Timed()` wraps `@Cacheable()` wraps `@Lock()` wraps
   * `@Retry()` wraps the method.
   *
   * The order is fixed here rather than taken from how the decorators are
   * stacked in the source, because the useful arrangement is the same every
   * time and reading it off the stacking order would make it depend on a detail
   * (decorators apply bottom-up) that nobody should have to remember. It means:
   * a cache hit costs no retries, a call that only succeeds on its third
   * attempt is cached once, and the recorded duration is what the caller
   * actually waited — cache lookup, lock contention, retries, backoff sleeps
   * and all.
   *
   * `@Lock()` sits between them for two reasons. Inside `@Cacheable()`, so a
   * cache hit — which reads nothing and writes nothing — does not queue behind
   * whoever holds the lock. Outside `@Retry()`, so the retries happen *while
   * holding* it: a retry ladder run outside the lock would drop the exclusion
   * between attempts and let another caller in halfway through.
   */
  private buildChain(
    instance: object,
    original: UnknownMethod,
    context: AspectContext,
    prototype: object,
  ): UnknownMethod {
    const cacheable = readAspectMetadata<ResolvedCacheableOptions>(
      CACHEABLE_METADATA,
      prototype,
      context.method,
    );
    const retry = readAspectMetadata<ResolvedRetryOptions>(
      RETRY_METADATA,
      prototype,
      context.method,
    );
    const timed = readAspectMetadata<ResolvedTimedOptions>(
      TIMED_METADATA,
      prototype,
      context.method,
    );
    const lock = readAspectMetadata<ResolvedLockOptions>(LOCK_METADATA, prototype, context.method);

    let invoke: AspectInvocation = (args) => original.apply(instance, args as unknown[]);

    if (retry) {
      invoke = applyRetry(invoke, context, retry, {
        clock: this.clock,
        random: this.random,
        logger: this.retryLogger,
      });
    }
    if (lock) {
      if (!this.distributedLock) {
        throw new AspectConfigurationError(
          `@Lock() on ${context.target}.${context.method}() needs a DISTRIBUTED_LOCK provider. ` +
            "Import LockingModule (it is global) and set DISTRIBUTED_LOCK in the environment.",
        );
      }
      invoke = applyLock(invoke, context, lock, {
        lock: this.distributedLock,
        clock: this.lockClock,
        logger: this.lockLogger,
      });
    }
    if (cacheable) {
      invoke = applyCacheable(invoke, context, cacheable, {
        cache: this.cache,
        logger: this.cacheableLogger,
      });
    }
    if (timed) {
      invoke = applyTiming(invoke, context, timed, {
        clock: this.clock,
        recorder: this.recorder,
        logger: this.timedLogger,
      });
    }

    const woven = (...args: unknown[]): unknown => invoke(args);
    // Keep the wrapper indistinguishable from the method it replaces for
    // anything that reflects over it — stack traces, `fn.length` arity checks.
    Object.defineProperty(woven, "name", { value: original.name, configurable: true });
    Object.defineProperty(woven, "length", { value: original.length, configurable: true });
    Object.defineProperty(woven, WOVEN, { value: true });
    return woven;
  }

  private collectSkips(
    wrapper: InstanceWrapper,
    reason: WeaveSkipReason,
    report: WeaveReport,
  ): void {
    const prototype = prototypeOf(wrapper);
    if (!prototype) return;

    for (const method of this.scanner.getAllMethodNames(prototype)) {
      if (hasAspectMetadata(prototype, method)) {
        const lock = readAspectMetadata(LOCK_METADATA, prototype, method) !== undefined;
        report.skipped.push({ target: nameOf(wrapper), method, reason, lock });
      }
    }
  }
}

/**
 * The prototype to read metadata from: the class for ordinary providers, the
 * instance's own prototype for `useValue` providers, which have no metatype.
 * Plain object literals land on `Object.prototype` and are not worth scanning.
 */
function prototypeOf(wrapper: InstanceWrapper): object | null {
  const metatype = wrapper.metatype as (new (...args: never[]) => unknown) | null | undefined;
  if (typeof metatype === "function" && metatype.prototype) {
    return metatype.prototype as object;
  }

  const instance = wrapper.instance as object | null | undefined;
  if (!instance || typeof instance !== "object") return null;

  const prototype = Object.getPrototypeOf(instance) as object | null;
  return prototype && prototype !== Object.prototype ? prototype : null;
}

function nameOf(wrapper: InstanceWrapper): string {
  const metatype = wrapper.metatype as { name?: string } | null | undefined;
  if (metatype?.name) return metatype.name;

  const instance = wrapper.instance as { constructor?: { name?: string } } | null | undefined;
  return instance?.constructor?.name ?? String(wrapper.name);
}
