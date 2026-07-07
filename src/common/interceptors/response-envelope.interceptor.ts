import { Injectable, NestInterceptor, ExecutionContext, CallHandler, HttpStatus } from "@nestjs/common";
import { Observable } from "rxjs";
import { map } from "rxjs/operators";
import type { Response } from "express";

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
export class ResponseEnvelopeInterceptor<T> implements NestInterceptor<T, ResponseEnvelope<T> | undefined> {
  intercept(context: ExecutionContext, next: CallHandler<T>): Observable<ResponseEnvelope<T> | undefined> {
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
