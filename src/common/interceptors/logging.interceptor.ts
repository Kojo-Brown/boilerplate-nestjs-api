import { Injectable, NestInterceptor, ExecutionContext, CallHandler, Logger } from "@nestjs/common";
import { Observable } from "rxjs";
import { tap } from "rxjs/operators";
import type { Request, Response } from "express";
import { randomUUID } from "crypto";
import type { AuthenticatedUser } from "@/auth/strategies/jwt.strategy";

export const CORRELATION_ID_HEADER = "x-correlation-id";

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

    return next.handle().pipe(
      tap({
        next: () => this.writeLog(req, res.statusCode, startedAt, correlationId),
        error: () => this.writeLog(req, res.statusCode || 500, startedAt, correlationId),
      }),
    );
  }

  private writeLog(req: RequestWithUser, statusCode: number, startedAt: number, correlationId: string): void {
    this.logger.log(
      JSON.stringify({
        correlationId,
        method: req.method,
        path: req.url,
        statusCode,
        latencyMs: Date.now() - startedAt,
        userId: req.user?.id ?? null,
      }),
    );
  }
}
