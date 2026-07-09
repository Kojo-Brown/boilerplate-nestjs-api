import { Injectable, NestInterceptor, ExecutionContext, CallHandler, HttpStatus } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { Observable } from "rxjs";
import { map } from "rxjs/operators";
import type { Response } from "express";
import { SKIP_RESPONSE_ENVELOPE_KEY } from "@/common/decorators/skip-response-envelope.decorator";

export interface ResponseMeta {
  timestamp: string;
  version: string;
}

export interface ResponseEnvelope<T> {
  success: true;
  data: T;
  meta: ResponseMeta;
}

@Injectable()
export class ResponseEnvelopeInterceptor<T> implements NestInterceptor<T, ResponseEnvelope<T> | T | undefined> {
  constructor(private readonly reflector: Reflector) {}

  intercept(context: ExecutionContext, next: CallHandler<T>): Observable<ResponseEnvelope<T> | T | undefined> {
    const skip = this.reflector.getAllAndOverride<boolean>(SKIP_RESPONSE_ENVELOPE_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (skip) {
      return next.handle();
    }

    const res = context.switchToHttp().getResponse<Response>();

    return next.handle().pipe(
      map((data) => {
        if (res.statusCode === HttpStatus.NO_CONTENT) {
          return undefined;
        }

        return {
          success: true as const,
          data,
          meta: {
            timestamp: new Date().toISOString(),
            version: "v1",
          },
        };
      }),
    );
  }
}
