import { Logger } from "@nestjs/common";
import { OnEvent } from "@nestjs/event-emitter";
import type {
  DomainEvent,
  DomainEventHandler,
  DomainEventName,
  HandlerOutcome,
} from "./domain-event";

/**
 * Subscribes a provider method to one domain event — the Observer side of the
 * pattern, and the only supported way to register a handler.
 *
 * ```ts
 * @Injectable()
 * export class WelcomeEmailListener {
 *   @OnDomainEvent("user.registered")
 *   async onUserRegistered(event: DomainEvent<"user.registered">): Promise<void> {
 *     await this.emails.sendWelcomeEmail({ to: event.payload.email, ... });
 *   }
 * }
 * ```
 *
 * Two things it adds over a bare `@OnEvent("user.registered")`:
 *
 * **The signature is checked.** The parameter must be `DomainEvent<K>` for the
 * `K` being subscribed to, so a handler reading `event.payload.provider` off a
 * `user.deleted` event does not compile. `@OnEvent` takes a `string` and hands
 * the listener `any`, which means a renamed field is a runtime `undefined` in a
 * subscriber nobody thought to grep for.
 *
 * **A failing handler is contained and attributed.** The method is wrapped so
 * that a rejection becomes a `failed` {@link HandlerOutcome} instead of an
 * exception. That matters more than it sounds: `EventEmitter2` invokes
 * listeners on the publisher's stack, so without containment a welcome email
 * that cannot reach the queue would fail the registration that triggered it —
 * the exact coupling this pattern exists to remove. `@nestjs/event-emitter`
 * does catch listener errors itself, but logs only `error.message` with no
 * event name, event id, or handler; and `DomainEventBus.publishAndSettle` could
 * not tell a caller *which* subscriber failed, because a swallowed rejection
 * looks identical to a handler that returned nothing.
 *
 * Note this is the one decorator in the codebase that wraps rather than only
 * writing metadata (contrast `@Cacheable()` and friends in `common/aspects`,
 * which defer to `AspectWeaver` because they need a cache and a clock at a
 * point where neither exists). The wrapper here closes over a `Logger` and
 * nothing else — no injectable collaborator, so there is nothing to wait for,
 * and doing it at decoration time keeps the handler's own metadata attached to
 * the function the loader actually subscribes. The file is deliberately not
 * named `*.decorator.ts`: that suffix is excluded from coverage collection,
 * which would be the wrong call for a file holding the error-containment path.
 */
export function OnDomainEvent<K extends DomainEventName>(event: K) {
  // Generic in the decorated method's own type rather than taking a
  // `TypedPropertyDescriptor<DomainEventHandler<K>>` directly: that descriptor
  // is invariant in its parameter (it carries a setter), so a handler declared
  // `Promise<void>` would not match a handler type declared `unknown` and every
  // subscriber in the codebase would fail to compile. Inferring `T` and
  // constraining it keeps the check where it belongs — on the event parameter.
  return <T extends DomainEventHandler<K>>(
    target: object,
    propertyKey: string | symbol,
    descriptor: TypedPropertyDescriptor<T>,
  ): void => {
    const handle = descriptor.value;
    if (typeof handle !== "function") {
      // A property holding an arrow function is not on the prototype, so the
      // subscriber loader would never find it and the handler would silently
      // never run. Fail at import time instead.
      throw new Error(
        `@OnDomainEvent("${event}") must decorate a method, but ` +
          `${target.constructor.name}.${String(propertyKey)} is not one`,
      );
    }

    const handler = `${target.constructor.name}.${String(propertyKey)}`;
    const logger = new Logger(handler);

    const wrapper = async function (
      this: unknown,
      domainEvent: DomainEvent<K>,
    ): Promise<HandlerOutcome> {
      try {
        await handle.call(this, domainEvent);
        return { handler, status: "ok" };
      } catch (caught) {
        const error = caught instanceof Error ? caught.message : String(caught);
        logger.error(
          `Handling ${domainEvent.name} (${domainEvent.id}) failed: ${error}`,
          caught instanceof Error ? caught.stack : undefined,
        );
        return { handler, status: "failed", error };
      }
    };

    // The wrapper resolves to a `HandlerOutcome` where the method resolved to
    // nothing, so it is deliberately not a `T`. That substitution is the whole
    // mechanism — the bus reads those outcomes to build its report — and it is
    // invisible in practice because a subscriber is called by the emitter and
    // never by hand.
    descriptor.value = wrapper as unknown as T;

    // Applied to the wrapper, not the original: the loader reads its metadata
    // off `instance[methodKey]`, which is whatever is on the descriptor now.
    // `suppressErrors: false` because the wrapper above has already handled
    // every error there is — leaving the default on would mean the framework's
    // catch is the one that runs, which is what this decorator exists to avoid.
    OnEvent(event, { suppressErrors: false })(target, propertyKey, descriptor);
  };
}

/**
 * Whether a value returned by a listener came from {@link OnDomainEvent}.
 *
 * The bus reads listener return values to build its report, and `emitAsync`
 * hands back whatever each listener resolved to — including `undefined` from a
 * plain `@OnEvent` handler someone registered on the same name.
 */
export function isHandlerOutcome(value: unknown): value is HandlerOutcome {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<HandlerOutcome>;
  return (
    typeof candidate.handler === "string" &&
    (candidate.status === "ok" || candidate.status === "failed")
  );
}
