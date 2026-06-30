import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
} from "@nestjs/common";
import type { Request, Response } from "express";

interface ErrorResponse {
  statusCode: number;
  message: string | string[];
  error: string;
  timestamp: string;
  path: string;
}

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const req = ctx.getRequest<Request>();

    const isHttp = exception instanceof HttpException;
    const status = isHttp ? exception.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR;

    const body: ErrorResponse = {
      statusCode: status,
      message: isHttp
        ? (exception.getResponse() as { message?: string | string[] }).message ?? exception.message
        : "Internal server error",
      error: isHttp ? (exception.getResponse() as { error?: string }).error ?? "Error" : "InternalServerError",
      timestamp: new Date().toISOString(),
      path: req.url,
    };

    res.status(status).json(body);
  }
}
