import { Global, Module } from "@nestjs/common";
import { EventEmitterModule } from "@nestjs/event-emitter";
import { DomainEventBus } from "./domain-event-bus.service";

/**
 * Wires the domain event bus.
 *
 * Global for the same reason `AspectsModule` is: any module may publish, and
 * making each one import `EventsModule` would reintroduce exactly the wiring
 * the pattern removes. Subscribers need no import at all — the loader
 * discovers `@OnDomainEvent` methods on every provider in the container.
 *
 * `wildcard` stays off deliberately. Turning it on changes what an event name
 * *is*: `EventEmitter2` starts splitting on the delimiter and matching through
 * a tree, so `user.registered` becomes a two-segment path and a stray
 * subscriber on `user.*` receives events it was never named in. The names here
 * are opaque strings that happen to contain a dot, and the catalogue in
 * `domain-event.ts` is small enough to subscribe to explicitly. `delimiter` is
 * set anyway so that the meaning of the dot is decided here rather than by a
 * default if wildcards are ever switched on.
 *
 * `verboseMemoryLeak` puts the event name in the warning `EventEmitter2` logs
 * past `maxListeners` subscribers on one event — without it the warning does
 * not say which event leaked, which makes it close to useless.
 */
@Global()
@Module({
  imports: [
    EventEmitterModule.forRoot({
      wildcard: false,
      delimiter: ".",
      verboseMemoryLeak: true,
      // Nothing publishes an `error` event, and if anything ever does, an
      // emitter that throws for want of a listener is a strictly worse failure
      // than a dropped reaction.
      ignoreErrors: true,
    }),
  ],
  providers: [DomainEventBus],
  exports: [DomainEventBus],
})
export class EventsModule {}
