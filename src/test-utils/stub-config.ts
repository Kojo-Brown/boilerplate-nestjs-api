import { ConfigService } from "@nestjs/config";

/**
 * A `ConfigService` backed by a plain object.
 *
 * Providers read configuration through `config.get(key)`, so a stub is enough
 * and is a great deal clearer at the call site than booting `ConfigModule` with
 * a temporary `.env`.
 */
export function stubConfig(env: Record<string, string | undefined>): ConfigService {
  return { get: (key: string): unknown => env[key] } as unknown as ConfigService;
}
