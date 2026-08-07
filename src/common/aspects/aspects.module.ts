import { Global, Module } from "@nestjs/common";
import { DiscoveryModule } from "@nestjs/core";
import { CacheService } from "@/common/cache";
import { AspectWeaver } from "./aspect-weaver.service";
import {
  ASPECT_CACHE,
  ASPECT_CLOCK,
  ASPECT_RANDOM,
  LoggingMethodTimingRecorder,
  METHOD_TIMING_RECORDER,
  SystemAspectClock,
  SystemAspectRandom,
} from "./ports";

/**
 * Wires the method aspects.
 *
 * Global because the weaver reaches across every module's providers, so
 * importing it anywhere but the root would be misleading — and because the
 * three ports below are the extension points: bind
 * {@link METHOD_TIMING_RECORDER} to your metrics client to get `@Timed()`
 * samples out of the log and into a dashboard.
 *
 * `ASPECT_CACHE` is an alias of `CacheService` rather than a second cache, so
 * `@Cacheable()` entries share the Redis instance (or the in-process store when
 * `REDIS_URL` is unset) that `AppCacheModule` configures, and can be invalidated
 * through the same service.
 */
@Global()
@Module({
  imports: [DiscoveryModule],
  providers: [
    AspectWeaver,
    { provide: ASPECT_CACHE, useExisting: CacheService },
    { provide: ASPECT_CLOCK, useClass: SystemAspectClock },
    { provide: ASPECT_RANDOM, useClass: SystemAspectRandom },
    { provide: METHOD_TIMING_RECORDER, useClass: LoggingMethodTimingRecorder },
  ],
  exports: [ASPECT_CACHE, ASPECT_CLOCK, ASPECT_RANDOM, METHOD_TIMING_RECORDER],
})
export class AspectsModule {}
