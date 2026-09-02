import { Module } from "@nestjs/common";
import { AuthModule } from "@/auth/auth.module";
import { RealtimeGateway } from "./realtime.gateway";

/**
 * The WebSocket gateway at `/v1/realtime`.
 *
 * `AuthModule` is imported for `JwtService`, which the gateway uses to verify
 * the handshake itself. That is the whole reason `AuthModule` re-exports
 * `JwtModule`: a second `JwtModule.registerAsync` here would be a second place
 * the signing secret and the algorithm are configured, and the failure when the
 * two drift is a token this API issues that its own WebSocket endpoint rejects.
 *
 * Nothing exports the gateway, for the same reason `StreamingModule` exports no
 * hub: a provider that wants to reach a specific client publishes a domain
 * event, and this subscribes. Reaching in to push a frame would put the
 * coupling back that `EventsModule` exists to remove.
 *
 * The gateway is inert without `app.useWebSocketAdapter(new WsAdapter(app))`
 * before `app.init()` — see `main.ts`. Nest's default is socket.io, which this
 * project does not install, so a missing adapter is a boot failure rather than
 * a silently dead endpoint.
 */
@Module({
  imports: [AuthModule],
  providers: [RealtimeGateway],
})
export class RealtimeModule {}
