import { Module } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { AuthModule } from "@/auth/auth.module";
import { EventStreamController } from "./event-stream.controller";
import { EventStreamHub, eventStreamOptionsFrom } from "./event-stream.service";

/**
 * The Server-Sent Events endpoint.
 *
 * `AuthModule` is imported for `JwtAuthGuard`, which the controller applies
 * per-route — no guard is global in this application beyond the throttler.
 *
 * `EventStreamHub` is a plain singleton with a value dependency rather than a
 * class that injects `ConfigService` itself. Two reasons, and the second is the
 * one that matters: its buffer size is fixed at construction, so the settings
 * have to be resolved before the instance exists either way; and a unit spec
 * can then build one with a two-entry buffer and a 10ms heartbeat by calling
 * the constructor, instead of standing up a configuration module to say so.
 *
 * Nothing exports the hub. A provider that wants to announce something publishes
 * a domain event and this subscribes, which is the direction the bus exists to
 * enforce — a caller reaching for the hub to push a frame at a specific client
 * would be reintroducing exactly the coupling `EventsModule` removes.
 */
@Module({
  imports: [AuthModule],
  controllers: [EventStreamController],
  providers: [
    {
      provide: EventStreamHub,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => new EventStreamHub(eventStreamOptionsFrom(config)),
    },
  ],
})
export class StreamingModule {}
