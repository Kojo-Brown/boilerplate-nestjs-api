import { ConfigService } from "@nestjs/config";
import type { Env } from "@/config/env.schema";

/**
 * A `ConfigService` backed by a plain object.
 *
 * Providers read configuration through `config.get(key)`, so a stub is enough
 * and is a great deal clearer at the call site than booting `ConfigModule` with
 * a temporary `.env`.
 *
 * Typed as both forms at once, because consumers declare either: an injectable
 * usually takes the loose `ConfigService`, while a module factory takes the
 * validated `ConfigService<Env, true>`. The two are not assignable to each
 * other — `WasValidated` changes whether `get` can return `undefined` — so an
 * intersection is what lets one stub stand in for both.
 */
export function stubConfig(env: Record<string, unknown>): ConfigService & ConfigService<Env, true> {
  return { get: (key: string): unknown => env[key] } as unknown as ConfigService &
    ConfigService<Env, true>;
}
