import { ApiPropertyOptional } from "@nestjs/swagger";
import { IsOptional, IsString, MaxLength } from "class-validator";

/**
 * The query string of `GET /v1/events/stream`.
 *
 * It exists for one field, and only because of a limitation in `EventSource`:
 * the browser API sends `Last-Event-ID` on the reconnects *it* performs, but
 * exposes no way to set a header on the initial request. So a client that
 * reconnects for its own reasons — a page reload, a tab restored from the
 * back/forward cache, a manual `new EventSource(...)` after an error it handled
 * itself — has no header to put its cursor in and would silently start from
 * "now". The query parameter is the only channel available to it.
 *
 * The header wins where both are present: it is the one the browser maintains,
 * and a stale URL should not override a cursor the runtime has kept current.
 *
 * The global `ValidationPipe` runs with `forbidNonWhitelisted`, so this class
 * is also what makes an unrecognised query parameter a 400 rather than
 * something the endpoint quietly ignores.
 */
export class EventStreamQueryDto {
  @ApiPropertyOptional({
    description:
      "Resume position, as issued in a previous frame's `id`. Ignored when the " +
      "`Last-Event-ID` header is present. A value this server did not issue is " +
      "reported back in the `stream.open` frame's `gap` field rather than rejected.",
    example: "0f8c1a2b3d4e5f60718293a4b5c6d7e8.42",
  })
  @IsOptional()
  @IsString()
  // Bounded because it is echoed into a log line on a failed resume. The cursors
  // this server issues are 35 characters; anything near this limit is already
  // not one, and `parseCursor` will say so.
  @MaxLength(256)
  readonly lastEventId?: string;
}
