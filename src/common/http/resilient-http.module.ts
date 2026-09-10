import { Module } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { setTimeout as sleep } from "node:timers/promises";
import { HTTP_RESILIENCE_OPTIONS } from "./http-resilience";
import type { ResilientHttpOptions } from "./http-resilience";
import { ResilientHttpClient } from "./resilient-http.client";

/**
 * Builds the one policy every dependency's breaker and ladder is configured
 * from.
 *
 * Read through `ConfigService` rather than from `process.env` so the values are
 * the ones `envSchema` coerced and refused to boot without — `HTTP_RETRY_*` and
 * `HTTP_BREAKER_*` are integers there, and the bucket arithmetic opossum needs
 * is checked at boot rather than discovered as a zero-millisecond timer.
 */
export function httpResilienceOptions(config: ConfigService): ResilientHttpOptions {
  return {
    retry: {
      maxAttempts: config.get<number>("HTTP_RETRY_MAX_ATTEMPTS", 3),
      baseMs: config.get<number>("HTTP_RETRY_BASE_MS", 200),
      maxMs: config.get<number>("HTTP_RETRY_MAX_DELAY_MS", 2_000),
    },
    breaker: {
      failureThresholdPercent: config.get<number>("HTTP_BREAKER_FAILURE_THRESHOLD_PERCENT", 50),
      volumeThreshold: config.get<number>("HTTP_BREAKER_VOLUME_THRESHOLD", 10),
      rollingWindowMs: config.get<number>("HTTP_BREAKER_ROLLING_WINDOW_MS", 10_000),
      rollingBuckets: config.get<number>("HTTP_BREAKER_ROLLING_BUCKETS", 10),
      resetTimeoutMs: config.get<number>("HTTP_BREAKER_RESET_TIMEOUT_MS", 30_000),
    },
    bulkhead: {
      maxConcurrent: config.get<number>("HTTP_BULKHEAD_MAX_CONCURRENT", 20),
      maxQueued: config.get<number>("HTTP_BULKHEAD_MAX_QUEUED", 20),
      maxQueueWaitMs: config.get<number>("HTTP_BULKHEAD_QUEUE_TIMEOUT_MS", 1_000),
    },
    deadlineMs: config.get<number>("HTTP_REQUEST_DEADLINE_MS", 25_000),
    // `node:timers/promises` rather than a hand-rolled `setTimeout` wrapper:
    // its timer is `unref`able and it does not leave a dangling handle when the
    // process is shutting down mid-ladder.
    sleep: (ms) => sleep(ms),
    random: Math.random,
    // `performance.now()` rather than `Date.now()`: this only ever feeds
    // deadline subtraction, and a wall clock that an NTP correction steps
    // backwards mid-request extends that deadline by however far it stepped —
    // or, stepping forwards, expires a request that has been running for a
    // millisecond.
    now: () => performance.now(),
  };
}

/**
 * Provides {@link ResilientHttpClient} to whoever makes outbound calls.
 *
 * Imported explicitly by `PaymentsModule` and `NotificationsModule` rather than
 * made `@Global()`: two modules is not a reason to put something in every
 * injector, and an explicit import is what makes "this module talks to the
 * outside world" visible in its own file.
 */
@Module({
  providers: [
    {
      provide: HTTP_RESILIENCE_OPTIONS,
      inject: [ConfigService],
      useFactory: httpResilienceOptions,
    },
    ResilientHttpClient,
  ],
  exports: [ResilientHttpClient],
})
export class ResilientHttpModule {}
