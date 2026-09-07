import { Injectable, Logger } from "@nestjs/common";
import { SagaDefinitionError, UnknownSagaError } from "./saga.errors";
import type { SagaDefinition } from "./saga-definition";
import type { SagaState } from "./saga-state";

/**
 * Every saga this build knows how to run, by name.
 *
 * It exists because of the recovery poller. An instance is a row: it names its
 * definition and nothing else, so something has to turn `"order.checkout"` back
 * into the steps. A poller that instead injected the definitions it knew about
 * would have to be edited for every new saga — the registry is what keeps a
 * second saga a change in its own module and nowhere else (OCP, the same
 * inversion `PAYMENT_PROVIDERS` makes for gateways).
 *
 * Definitions register themselves from `onModuleInit`, which is early enough:
 * Nest runs every module's `onModuleInit` before any `onApplicationBootstrap`,
 * and the poller starts in the latter. A saga registered later than that would
 * be missing from the first few polls, so registration from a request path or a
 * lazily constructed provider is not supported and `assertRegistered` says so
 * rather than resolving to `undefined` at 3am.
 */
@Injectable()
export class SagaRegistry {
  private readonly logger = new Logger(SagaRegistry.name);
  private readonly definitions = new Map<string, SagaDefinition<SagaState>>();

  /**
   * Adds a definition, refusing a second one under the same name.
   *
   * The cast is the boundary where the state type is erased, and it is confined
   * to this line. A registry holding `SagaDefinition<S>` for every distinct `S`
   * is not expressible — the orchestrator resolves a definition from a string
   * read out of a database, so there is no `S` in scope to resolve it at.
   * Everything downstream of here treats the state as JSON, which is what it is
   * in the row; the type parameter's job is to check a definition against its
   * own steps *before* it gets here, which it has already done.
   */
  register<S extends SagaState>(definition: SagaDefinition<S>): void {
    if (this.definitions.has(definition.name)) {
      throw new SagaDefinitionError(definition.name, "is registered twice");
    }
    this.definitions.set(definition.name, definition as unknown as SagaDefinition<SagaState>);
    this.logger.log(
      `Registered saga "${definition.name}" (${definition.steps.length} steps: ` +
        `${definition.steps.map((step) => step.name).join(" → ")})`,
    );
  }

  /** The definition for a name, or `null` — the poller's case, which is not an error. */
  find(name: string): SagaDefinition<SagaState> | null {
    return this.definitions.get(name) ?? null;
  }

  /** The definition for a name, or {@link UnknownSagaError}. */
  require(name: string): SagaDefinition<SagaState> {
    const definition = this.find(name);
    if (!definition) throw new UnknownSagaError(name);
    return definition;
  }

  /** Every registered name, for the boot log and for tests. */
  names(): readonly string[] {
    return [...this.definitions.keys()];
  }
}
