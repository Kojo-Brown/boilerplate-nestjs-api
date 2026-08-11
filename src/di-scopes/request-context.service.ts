import { Inject, Injectable, Scope } from "@nestjs/common";
import { REQUEST } from "@nestjs/core";
import type { Request } from "express";
import { CORRELATION_ID_HEADER } from "@/common/interceptors/logging.interceptor";
import { InstantiationLedger } from "./instantiation-ledger.service";
import { ScopedLogger } from "./scoped-logger.service";

/** What a request-scoped provider can say about the request that made it. */
export interface RequestFacts {
  readonly correlationId: string;
  readonly method: string;
  readonly path: string;
}

const NO_REQUEST: RequestFacts = { correlationId: "none", method: "none", path: "none" };

/**
 * Per-request state, held by the only kind of provider that can safely hold it.
 *
 * `Scope.REQUEST` means Nest constructs one of these per incoming request and
 * discards it when the response finishes, so the fields below are private to
 * that request by construction rather than by discipline. The same three lines
 * on a singleton would be a data leak between concurrent users, and a
 * particularly nasty one: it looks correct under any load light enough that
 * requests do not overlap.
 *
 * That safety is not free, and the price is not paid by this class — it is
 * paid by everything that injects it. See
 * [docs/di-scopes.md](../../docs/di-scopes.md); {@link AuditTrailService} is
 * the worked example.
 *
 * Before reaching for request scope, check whether the request is already
 * where you need it. A controller has `@Req()`, an interceptor and a guard
 * have `ExecutionContext`, and passing a correlation id down as an argument
 * costs one parameter and no scope at all. Request scope earns its keep when
 * the consumer is *deep* — several layers below anything holding the request —
 * and threading an argument through every layer would be worse.
 */
@Injectable({ scope: Scope.REQUEST })
export class RequestContextService {
  readonly instanceId: string;

  readonly facts: RequestFacts;

  private readonly bag = new Map<string, unknown>();

  constructor(
    ledger: InstantiationLedger,
    private readonly logger: ScopedLogger,
    // `@Inject(REQUEST)` resolves to the underlying HTTP request for a
    // request-scoped provider reached through the router. It is typed as
    // possibly absent because that is not the only way one gets built:
    // `moduleRef.resolve()` with a context id of its own — a queue consumer, a
    // cron job, a test — creates a real instance with no request behind it.
    @Inject(REQUEST) request?: Request,
  ) {
    this.instanceId = ledger.record(RequestContextService.name);
    this.facts = factsOf(request);
  }

  /** Stores a value for the rest of *this* request only. */
  set(key: string, value: unknown): void {
    this.bag.set(key, value);
  }

  get<T>(key: string): T | undefined {
    return this.bag.get(key) as T | undefined;
  }

  get correlationId(): string {
    return this.facts.correlationId;
  }

  /** The logger's host name, exposed so the transient wiring can be asserted on. */
  loggerHost(): string {
    return this.logger.host;
  }
}

function factsOf(request: Request | undefined): RequestFacts {
  if (!request?.method) return NO_REQUEST;
  const header = request.headers?.[CORRELATION_ID_HEADER];
  return {
    // `LoggingInterceptor` writes this header back onto the request before any
    // handler runs, so by the time a provider is constructed the id is the same
    // one the access log and the response header carry. Falling back to
    // `"unassigned"` rather than minting a fresh id is deliberate: a second id
    // for the same request would be worse than an obviously missing one.
    correlationId: typeof header === "string" ? header : "unassigned",
    method: request.method,
    path: request.url ?? "unknown",
  };
}
