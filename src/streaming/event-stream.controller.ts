import { Controller, Headers, Query, Sse, UseGuards, type MessageEvent } from "@nestjs/common";
import { ApiOkResponse, ApiOperation, ApiProduces, ApiTags } from "@nestjs/swagger";
import type { Observable } from "rxjs";
import { JwtAuthGuard } from "@/auth/guards/jwt-auth.guard";
import { CurrentUser } from "@/common/decorators/current-user.decorator";
import { SkipResponseEnvelope } from "@/common/decorators/skip-response-envelope.decorator";
import { ApiJwtAuth } from "@/common/swagger/api-jwt-auth.decorator";
import { ApiCommonErrors } from "@/common/swagger/api-error-responses.decorator";
import type { AuthenticatedUser } from "@/auth/strategies/jwt.strategy";
import { EventStreamHub } from "./event-stream.service";
import { EventStreamQueryDto } from "./dto/event-stream-query.dto";

@ApiTags("events")
@ApiJwtAuth()
@UseGuards(JwtAuthGuard)
@Controller("events")
export class EventStreamController {
  constructor(private readonly hub: EventStreamHub) {}

  /**
   * `@SkipResponseEnvelope()` is not cosmetic here, and removing it does not
   * fail loudly — which is why `event-stream.e2e-spec.ts` asserts on the frames
   * this route actually puts on the wire.
   *
   * Nest runs the global interceptor chain around an SSE handler exactly as it
   * does around any other, and for a handler returning an `Observable` the
   * chain is applied to the stream of `MessageEvent`s rather than to the
   * handler's return value. `ResponseEnvelopeInterceptor` would therefore `map`
   * every frame to `{ success, data: <frame>, meta }`, an object with no `type`
   * and no `id` — so every frame would arrive as an unnamed `message`, and
   * `Last-Event-ID` would never be set on the client at all. Resume would go on
   * appearing to work, because a client that has never been given a cursor
   * simply reconnects without one and is told it is starting fresh.
   */
  @Sse("stream")
  @SkipResponseEnvelope()
  @ApiOperation({
    summary: "Subscribe to the domain event stream (Server-Sent Events)",
    description: [
      "A long-lived `text/event-stream`. Each frame's SSE event type is the domain",
      "event's own name (`user.registered`, `user.deleted`), so a client subscribes",
      "with `addEventListener` and never demultiplexes a payload by hand.",
      "",
      "Administrators receive the whole catalogue; every other caller receives only",
      "events about their own account.",
      "",
      "Three control frames are namespaced under `stream.`: `stream.open` (always",
      "first, carrying the resume verdict and the reconnection hint), `stream.closing`",
      "(the process is shutting down), and `stream.heartbeat` — which carries an `id`",
      "and no data, so per the SSE specification it refreshes the client's",
      "`Last-Event-ID` without dispatching an event.",
      "",
      "Authentication is a bearer token. Browsers cannot set headers on an",
      "`EventSource`, so a browser client needs a fetch-based polyfill; see",
      "`docs/streaming.md` for why a token in the query string is not offered.",
    ].join("\n"),
  })
  @ApiProduces("text/event-stream")
  @ApiOkResponse({
    description: "The stream. Stays open until the client disconnects or the process stops.",
    content: { "text/event-stream": { schema: { type: "string" } } },
  })
  @ApiCommonErrors()
  stream(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: EventStreamQueryDto,
    @Headers("last-event-id") lastEventIdHeader?: string,
  ): Observable<MessageEvent> {
    return this.hub.connect(user, lastEventIdHeader ?? query.lastEventId);
  }
}
