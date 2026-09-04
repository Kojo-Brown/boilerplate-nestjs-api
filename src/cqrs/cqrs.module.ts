import { Global, Module } from "@nestjs/common";
import { CqrsModule } from "@nestjs/cqrs";
import { CqrsUnhandledExceptionLogger } from "./cqrs-unhandled-exception.logger";
import { DomainEventCqrsBridge } from "./domain-event-cqrs.bridge";

/**
 * Wires `@nestjs/cqrs` for the application.
 *
 * `CqrsModule.forRoot()` is imported exactly once, here. That matters more than
 * it looks: the bare `CqrsModule` is an ordinary module, so importing it a
 * second time in a feature module would build a *second* `CommandBus`,
 * `QueryBus` and `EventBus` in that module's injector, while
 * `ExplorerService` registers every discovered handler against the buses of
 * whichever `CqrsModule` instance ran `onApplicationBootstrap`. Half the
 * application would then dispatch into a bus with no handlers registered, and
 * the symptom is a `CommandHandlerNotFoundException` for a handler that is
 * plainly in the providers list. `forRoot()` returns `global: true`, so the
 * buses are injectable everywhere without any module importing anything.
 *
 * Handlers themselves are declared by the module that owns them — the users
 * module provides its own commands, queries and projections — because the
 * explorer walks the whole container and does not care where a
 * `@CommandHandler` lives. Keeping them in the feature module is what stops
 * this file from becoming a registry of everything.
 *
 * Global for the same reason `EventsModule` is: dispatching is not a coupling
 * worth an import edge in every feature module, and the buses hold no state a
 * module could want its own copy of.
 */
@Global()
@Module({
  imports: [CqrsModule.forRoot()],
  providers: [DomainEventCqrsBridge, CqrsUnhandledExceptionLogger],
  exports: [CqrsModule],
})
export class AppCqrsModule {}
