import { Injectable, type ArgumentMetadata, type PipeTransform } from "@nestjs/common";
import { deepFreeze } from "./deep-freeze";

/**
 * The types `ValidationPipe` itself refuses to validate, and for the same
 * reason: reaching one of these means the parameter was never transformed into
 * a DTO, so the value is whatever the framework already had.
 */
const NATIVE_TYPES: readonly unknown[] = [String, Boolean, Number, Array, Object];

/**
 * Freezes validated request payloads, outside production.
 *
 * Bound *after* `ValidationPipe` so it freezes the DTO instance the handler
 * will actually receive rather than the plain body that went in — freezing
 * first would only harden a value `class-transformer` is about to replace.
 *
 * The point is to fail where the mistake is. A handler or an interceptor that
 * normalises its input in place (`dto.email = dto.email.toLowerCase()`) works
 * fine in isolation and goes wrong once the same payload is read twice — on an
 * idempotent replay, in a retry, or from a value that turned out to be shared.
 * Frozen, the write throws a `TypeError` on the line that performs it. That
 * only works because `strict: true` implies `alwaysStrict`, so every compiled
 * module is strict mode and a write to a frozen property throws instead of
 * being silently discarded, which is what sloppy mode does.
 *
 * ### What it will not touch
 *
 * Only parameters whose metatype is a user-defined class — the ones
 * `ValidationPipe` has just produced a fresh instance of. Everything else is a
 * value the framework owns and keeps using:
 *
 * - `type: "custom"` covers `@Req()`, `@Res()`, `@UploadedFile()` and every
 *   custom decorator such as `@CurrentUser()`. Freezing an Express request or
 *   response would break the framework outright — both are mutated throughout
 *   the request lifecycle — and a Multer file cannot be frozen anyway.
 * - A native metatype (`@Param("id") id: string`, or an untyped `@Query()`)
 *   means the value is the raw `req.query`/`req.params` object Express built
 *   and may reuse. Primitives need no freezing, and the objects are not ours.
 */
@Injectable()
export class DeepFreezePipe implements PipeTransform {
  constructor(private readonly enabled: boolean) {}

  transform(value: unknown, metadata: ArgumentMetadata): unknown {
    if (!this.enabled || !this.appliesTo(metadata)) return value;
    return deepFreeze(value);
  }

  private appliesTo(metadata: ArgumentMetadata): boolean {
    if (metadata.type === "custom") return false;
    const { metatype } = metadata;
    if (!metatype) return false;
    return !NATIVE_TYPES.includes(metatype);
  }
}

/**
 * Whether payload freezing is on for a given environment.
 *
 * Off in production, where the traversal is pure cost against a guarantee the
 * type layer already provides at compile time, and where turning a latent
 * mutation into a thrown `TypeError` would convert a subtly wrong response into
 * a 500. Development and test are exactly where that trade runs the other way.
 */
export function freezingEnabledFor(nodeEnv: string | undefined): boolean {
  return nodeEnv !== "production";
}
