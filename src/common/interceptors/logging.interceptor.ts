import { Injectable, NestInterceptor, ExecutionContext, CallHandler, Logger } from "@nestjs/common";
import { Observable } from "rxjs";
import { finalize } from "rxjs/operators";
import type { Request, Response } from "express";
import { randomUUID } from "crypto";
import { trace } from "@opentelemetry/api";
import type { AuthenticatedUser } from "@/auth/strategies/jwt.strategy";
import { activeTraceFields } from "@/telemetry";

export const CORRELATION_ID_HEADER = "x-correlation-id";

/**
 * The attribute the correlation id is put on the request's span.
 *
 * Not a semantic-convention name, because there is no convention for this: it
 * is this service's own id for a request, minted here when the caller did not
 * send one. It earns its place by being the join in both directions — an
 * operator holding a `x-correlation-id` from a client's bug report can find the
 * trace, and an operator holding a trace can find every log line that names it.
 */
export const CORRELATION_ID_ATTRIBUTE = "app.correlation_id";

interface RequestWithUser extends Request {
  user?: AuthenticatedUser;
}

@Injectable()
export class LoggingInterceptor implements NestInterceptor {
  private readonly logger = new Logger(LoggingInterceptor.name);

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = context.switchToHttp().getRequest<RequestWithUser>();
    const res = context.switchToHttp().getResponse<Response>();

    const correlationId =
      (req.headers[CORRELATION_ID_HEADER] as string | undefined) ?? randomUUID();
    const startedAt = Date.now();

    req.headers[CORRELATION_ID_HEADER] = correlationId;
    res.setHeader(CORRELATION_ID_HEADER, correlationId);

    // The span belongs to the HTTP and Express instrumentations, not to this
    // interceptor — which is the point. The request already has spans and both
    // the access log and the trace hang off them, rather than off a second,
    // redundant span that would deepen every trace and agree with the
    // instrumentation's about everything.
    //
    // `getActiveSpan()` is undefined when the SDK is off, and the whole block
    // costs one property read in that case.
    trace.getActiveSpan()?.setAttribute(CORRELATION_ID_ATTRIBUTE, correlationId);

    // `finalize` rather than `tap`, because an access log has to record every
    // request that ends, not only the ones that produce a value. An interceptor
    // downstream may answer the request itself and complete without emitting —
    // `IdempotencyInterceptor` does exactly that when it replays a stored
    // response — and a client that disconnects unsubscribes without either a
    // `next` or an `error`. Both used to leave no line at all.
    return next
      .handle()
      .pipe(finalize(() => this.writeLog(req, res.statusCode || 500, startedAt, correlationId)));
  }

  private writeLog(
    req: RequestWithUser,
    statusCode: number,
    startedAt: number,
    correlationId: string,
  ): void {
    const traceFields = activeTraceFields();
    this.logger.log(
      JSON.stringify({
        correlationId,
        method: req.method,
        path: req.url,
        statusCode,
        latencyMs: Date.now() - startedAt,
        userId: req.user?.id ?? null,
        // Spelled in snake_case, unlike every other field here, because these
        // two are not ours to name: they are the OpenTelemetry logs data
        // model's, and a collector scraping stdout joins a log line to its
        // trace by finding exactly these keys. `null` when the request is not
        // being recorded — either the SDK is off, or the sampler dropped this
        // trace — which is honest, where omitting the keys would leave a
        // collector unable to tell a dropped trace from a parse failure.
        //
        // Read inside `finalize`, which runs while the request's context is
        // still active, so these are the ids of the span the line describes.
        trace_id: traceFields?.traceId ?? null,
        span_id: traceFields?.spanId ?? null,
      }),
    );
  }
}
