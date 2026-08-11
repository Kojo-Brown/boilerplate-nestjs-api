import { Injectable } from "@nestjs/common";
import { ContextIdFactory, ModuleRef } from "@nestjs/core";
import type { ContextId } from "@nestjs/core";
import { RequestContextService } from "./request-context.service";

/** The subset of a request object this resolver needs — anything Nest can key a context off. */
export type ContextCarrier = Record<PropertyKey, unknown>;

/**
 * Reaches a request-scoped provider from a singleton, without becoming one.
 *
 * This is the escape hatch for the case argument-passing cannot reach: a
 * global interceptor, a guard, an exception filter, or a singleton service
 * several layers down that needs the request context but must not be rebuilt
 * per request. Injecting {@link RequestContextService} into any of those would
 * work and would spread request scope to them and to everything above them —
 * and for a global enhancer, Nest would go further and instantiate it per
 * request for *every route in the application*, not just the ones that use it.
 *
 * `ModuleRef` is a singleton, so nothing here inherits a scope. The context id
 * is what does the work: Nest attaches one to every incoming request and keys
 * request-scoped instances by it, so resolving with the id the request already
 * carries returns *the instance that request is already using* rather than a
 * second one with the same data. Two calls with the same request return the
 * same object; two different requests never do.
 *
 * The other caller has no router behind it at all — a queue consumer, a cron
 * tick — and that case needs the two lines around the resolve. `getByRequest`
 * only recognises a context the router attached; given anything else it mints
 * a fresh one *on every call*, so a job resolving twice would get two contexts,
 * two instances, and none of them bound to the `REQUEST` provider.
 * `registerRequestByContextId` fixes the binding and `contexts` fixes the
 * churn. For a real HTTP request neither changes anything: the id comes from
 * the router either way, and re-binding rebinds the request that is already
 * bound.
 *
 * Two costs, both real and neither fatal:
 *
 * 1. `resolve()` is async. A synchronous caller cannot use it.
 * 2. It is a service locator. The dependency is resolved by token at the call
 *    site instead of declared in a constructor, so it is invisible to the
 *    container's static graph and a missing provider is a runtime failure
 *    rather than a boot-time one. That is a genuine loss, and it is the reason
 *    to prefer passing the correlation id as an argument when you can.
 */
@Injectable()
export class RequestContextResolver {
  /**
   * Carrier → context id, so repeated calls for one request or one job share
   * an instance. Weak because the carrier is the request object: holding it
   * strongly would pin every request this resolver ever saw, along with its
   * headers and body, for the life of the process.
   */
  private readonly contexts = new WeakMap<ContextCarrier, ContextId>();

  constructor(private readonly moduleRef: ModuleRef) {}

  /**
   * The {@link RequestContextService} belonging to `carrier`'s request.
   *
   * `strict: false` because the resolver is registered in `DiScopesModule` and
   * a caller elsewhere — an interceptor declared in the root module — would
   * otherwise be looking in the wrong module for the token.
   */
  async forRequest(carrier: ContextCarrier): Promise<RequestContextService> {
    const contextId = this.contextFor(carrier);
    return this.moduleRef.resolve(RequestContextService, contextId, { strict: false });
  }

  private contextFor(carrier: ContextCarrier): ContextId {
    const known = this.contexts.get(carrier);
    if (known) return known;

    const contextId = ContextIdFactory.getByRequest(carrier);
    this.contexts.set(carrier, contextId);
    this.moduleRef.registerRequestByContextId(carrier, contextId);
    return contextId;
  }
}
