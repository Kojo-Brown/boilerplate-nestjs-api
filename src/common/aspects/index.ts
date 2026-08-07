export { AspectsModule } from "./aspects.module";
export { AspectWeaver } from "./aspect-weaver.service";
export type { WeaveReport, WeaveSkip, WeaveSkipReason } from "./aspect-weaver.service";

export { Cacheable } from "./cacheable.decorator";
export { Retry } from "./retry.decorator";
export { Timed } from "./timed.decorator";

export type { CacheableOptions } from "./cacheable.aspect";
export { DEFAULT_RETRY_OPTIONS, isTransientError } from "./retry.aspect";
export type { RetryBackoff, RetryOptions } from "./retry.aspect";
export type { TimedOptions } from "./timed.aspect";

export { AspectConfigurationError, AspectUsageError } from "./aspect.types";
export { UnserializableArgumentError, stableStringify } from "./cache-key";

export {
  ASPECT_CACHE,
  ASPECT_CLOCK,
  ASPECT_RANDOM,
  METHOD_TIMING_RECORDER,
  LoggingMethodTimingRecorder,
  SystemAspectClock,
  SystemAspectRandom,
} from "./ports";
export type {
  AspectCacheStore,
  AspectClock,
  AspectRandom,
  MethodTiming,
  MethodTimingRecorder,
} from "./ports";
