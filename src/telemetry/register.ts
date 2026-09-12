import { telemetryEnvSchema } from "./telemetry.env";
import { telemetryOptionsFrom } from "./telemetry.options";
import { startTelemetry, type TelemetryHandle } from "./otel-sdk";

/**
 * The side-effecting entry point: importing this file installs the SDK.
 *
 * It is the **first** import in `main.ts`, ahead of `reflect-metadata` and
 * anything that reaches `AppModule`, and that ordering is the whole reason this
 * file exists separately from the rest of the module.
 * `HttpInstrumentation` and `ExpressInstrumentation` patch the exports of `http`
 * and `express` through a `require` hook, so the modules have to be loaded
 * *after* the hook is installed. A telemetry setup done inside a Nest provider —
 * the obvious place, and the wrong one — runs after the whole application graph
 * has been constructed, by which point there is nothing left to patch and the
 * result is an SDK that reports manual spans and no HTTP at all.
 *
 * Configuration is read straight from `process.env` through the same Zod schema
 * `envSchema` uses, because `ConfigService` does not exist yet either.
 *
 * Nothing here runs in the test suites: they build `AppModule` directly and
 * never import `main.ts`. A test that wants a live SDK calls `startTelemetry`
 * itself with options it chose.
 */
export const telemetry: TelemetryHandle = startTelemetry(
  (() => {
    const env = telemetryEnvSchema.parse(process.env);
    return telemetryOptionsFrom(env, env.NODE_ENV);
  })(),
);
