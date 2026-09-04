import { Injectable, Logger } from "@nestjs/common";
import type { OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { UnhandledExceptionBus } from "@nestjs/cqrs";
import type { Subscription } from "rxjs";

/**
 * Logs what the CQRS buses could not deliver.
 *
 * `EventBus` and `CommandBus` both wrap their dispatch in `catchError` and push
 * the failure onto `UnhandledExceptionBus` — and nothing subscribes to that bus
 * unless somebody writes this class. Without it, an `@EventsHandler` that
 * throws produces no log line, no metric and no failed request: the event is
 * simply dropped, which is the worst way to find out that a projection has been
 * dead since a deploy three weeks ago.
 *
 * It logs and does not rethrow. `rethrowUnhandled` in `CqrsModule.forRoot`
 * would turn a failed projection into an unhandled rejection on whichever stack
 * happened to publish the event — the outbox relay, or a WebSocket frame — and
 * take the process down for work that was explicitly chosen as safe to lose.
 * The name is carried in the message so the line says *which* handler, since
 * the exception itself usually does not.
 */
@Injectable()
export class CqrsUnhandledExceptionLogger implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CqrsUnhandledExceptionLogger.name);

  private subscription?: Subscription;

  constructor(private readonly unhandled: UnhandledExceptionBus) {}

  onModuleInit(): void {
    this.subscription = this.unhandled.subscribe(({ cause, exception }) => {
      const source = describe(cause);
      const error = exception instanceof Error ? exception : new Error(String(exception));
      this.logger.error(`Unhandled CQRS exception from ${source}: ${error.message}`, error.stack);
    });
  }

  onModuleDestroy(): void {
    this.subscription?.unsubscribe();
  }
}

/** The class name of the command or event that was being handled. */
function describe(cause: unknown): string {
  if (typeof cause !== "object" || cause === null) return "an unknown source";
  return (
    (Object.getPrototypeOf(cause) as { constructor?: { name?: string } } | null)?.constructor
      ?.name ?? "an anonymous class"
  );
}
