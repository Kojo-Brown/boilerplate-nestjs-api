import {
  BadRequestException,
  CallHandler,
  ConflictException,
  ExecutionContext,
  Inject,
  Injectable,
  Logger,
  NestInterceptor,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { randomUUID } from "node:crypto";
import { EMPTY, Observable } from "rxjs";
import type { Request, Response } from "express";
import { IDEMPOTENCY_STORE } from "./ports";
import type { CompletedRecord, IdempotencyStore, RecordedResponse } from "./ports";
import {
  IDEMPOTENCY_KEY_HEADER,
  IDEMPOTENCY_REPLAYED_HEADER,
  callerScope,
  fingerprint,
  isReplayableMethod,
  isValidKey,
  storeKey,
} from "./idempotency-key";
import type { Env } from "@/config/env.schema";

/**
 * Below this, the response is the operation's outcome and replaying it is the
 * whole point — including a 4xx, because the same key naming the same request
 * has the same answer, and a client that "fixes" its payload and reuses the key
 * is the bug this module refuses rather than accommodates.
 *
 * At or above it, the server does not know what happened. Recording a 500 would
 * make it permanent for the TTL and take the retry away from the client, so the
 * reservation is released instead and the next attempt runs for real.
 */
const REPLAYABLE_STATUS_CEILING = 500;

/**
 * Makes `Idempotency-Key` mean something on every mutating route.
 *
 * The flow is the one in draft-ietf-httpapi-idempotency-key-header: reserve the
 * key atomically, run the handler once, record what the client received, and
 * hand that same response to every retry until the record expires. A second
 * request that arrives while the first is still running gets 409 rather than a
 * half-answer, and a key reused for a *different* request gets 422 rather than
 * someone else's response body.
 *
 * It participates only when a client opts in by sending the header, so no
 * existing route changes behaviour until someone asks it to.
 *
 * The response is captured at `res.send` rather than from the handler's return
 * value, which is deliberate: what has to be replayed is the bytes the client
 * received, and those exist only after `ResponseEnvelopeInterceptor` has
 * wrapped them, `ValidationPipe` has rejected them, or `AllExceptionsFilter`
 * has rendered them. Anything read earlier is a different response that merely
 * looks similar.
 */
@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  private readonly logger = new Logger(IdempotencyInterceptor.name);

  private readonly ttlMs: number;

  constructor(
    @Inject(IDEMPOTENCY_STORE) private readonly store: IdempotencyStore,
    config: ConfigService<Env, true>,
  ) {
    this.ttlMs = config.get("IDEMPOTENCY_TTL_SECONDS", { infer: true }) * 1000;
  }

  async intercept(context: ExecutionContext, next: CallHandler): Promise<Observable<unknown>> {
    if (context.getType() !== "http") return next.handle();

    const req = context.switchToHttp().getRequest<Request>();
    const res = context.switchToHttp().getResponse<Response>();

    const header = req.headers[IDEMPOTENCY_KEY_HEADER];
    if (header === undefined || !isReplayableMethod(req.method)) return next.handle();

    if (Array.isArray(header)) {
      throw new BadRequestException("Idempotency-Key must be sent exactly once");
    }
    if (!isValidKey(header)) {
      throw new BadRequestException(
        "Idempotency-Key must be 1-255 printable ASCII characters and not blank",
      );
    }

    const key = storeKey(callerScope(req), header);
    const requestFingerprint = fingerprint(req);
    const lease = randomUUID();

    const existing = await this.reserve(key, requestFingerprint, lease);

    if (existing) {
      if (existing.fingerprint !== requestFingerprint) {
        throw new UnprocessableEntityException(
          "Idempotency-Key has already been used for a different request",
        );
      }
      if (existing.state === "in-flight") {
        throw new ConflictException("A request with this Idempotency-Key is still being processed");
      }

      this.replay(res, existing);
      // Nothing downstream runs and nothing further is written: the response is
      // already complete. Completing without a value is how an interceptor
      // says so — returning `of(body)` would hand the recorded bytes back to
      // the serialiser and re-encode them.
      return EMPTY;
    }

    this.recordOnce(req, res, key, lease);
    return next.handle();
  }

  /**
   * Fails closed.
   *
   * A store that cannot answer means the server cannot tell a first attempt
   * from a retry. Running the handler anyway is how a client ends up charged
   * twice, so an unreachable Redis makes mutating requests unavailable rather
   * than unsafe — and 503 is the status that tells a client to come back.
   */
  private async reserve(key: string, requestFingerprint: string, lease: string) {
    try {
      return await this.store.reserve(
        key,
        { state: "in-flight", fingerprint: requestFingerprint, lease },
        this.ttlMs,
      );
    } catch (error) {
      this.logger.error(`Idempotency store unavailable; refusing the request: ${describe(error)}`);
      throw new ServiceUnavailableException("Idempotency store is unavailable");
    }
  }

  private replay(res: Response, record: CompletedRecord): void {
    res.status(record.response.status);
    res.setHeader(IDEMPOTENCY_REPLAYED_HEADER, "true");

    if (record.response.contentType !== null) {
      res.setHeader("Content-Type", record.response.contentType);
    }

    if (record.response.body === null) {
      res.end();
      return;
    }

    res.send(record.response.body);
  }

  /**
   * Arranges for whatever the client ends up receiving to be recorded, exactly
   * once, however the response is produced.
   *
   * `send` is patched to keep the body — the response object exposes headers
   * and status after the fact but never the payload — while status and
   * `Content-Type` are read on `finish`, when they are final. Express routes
   * every JSON response through `send`, including the exception filter's, so
   * one hook covers handlers, pipes and filters alike.
   */
  private recordOnce(req: Request, res: Response, key: string, lease: string): void {
    let body: string | null = null;
    let wroteThroughSend = false;
    let settled = false;

    const send = res.send.bind(res);
    res.send = (payload?: unknown): Response => {
      // `res.json` re-enters through `send` with the serialised string, so the
      // last call is the one holding the bytes that go on the wire.
      if (typeof payload === "string") {
        body = payload;
      } else if (payload === undefined || payload === null) {
        body = null;
      }
      wroteThroughSend = true;
      return send(payload);
    };

    const settle = (persist: boolean): void => {
      if (settled) return;
      settled = true;

      if (!persist) {
        void this.release(key, lease, "the connection closed before the response finished");
        return;
      }

      if (res.statusCode >= REPLAYABLE_STATUS_CEILING) {
        void this.release(key, lease, `the request failed with ${res.statusCode}`);
        return;
      }

      if (!wroteThroughSend) {
        // A streamed or piped body never passes through `send`, so there is
        // nothing to replay. Releasing keeps the key usable rather than
        // pinning it to a response this module cannot reproduce.
        void this.release(
          key,
          lease,
          `${req.method} ${req.originalUrl} wrote its body without res.send(), so it cannot be replayed`,
        );
        return;
      }

      void this.persist(key, lease, {
        status: res.statusCode,
        contentType: contentTypeOf(res),
        body,
      });
    };

    res.on("finish", () => settle(true));
    res.on("close", () => settle(false));
  }

  private async persist(key: string, lease: string, response: RecordedResponse): Promise<void> {
    try {
      const stored = await this.store.complete(key, lease, response, this.ttlMs);
      if (!stored) {
        // The reservation expired mid-request and someone else now owns the
        // key. Dropping this response is the point of the lease: the client
        // will be answered by whichever request currently holds it.
        this.logger.warn(`Idempotency record for ${key} was claimed by a newer request`);
      }
    } catch (error) {
      // The response has already gone out, so there is nothing to fail. Leaving
      // the reservation in place would 409 every retry until the TTL, so try to
      // clear it and say so if that fails too.
      this.logger.error(`Could not record idempotent response for ${key}: ${describe(error)}`);
      await this.release(key, lease, "the response could not be recorded");
    }
  }

  private async release(key: string, lease: string, why: string): Promise<void> {
    try {
      await this.store.release(key, lease);
      this.logger.debug(`Released idempotency key ${key}: ${why}`);
    } catch (error) {
      this.logger.error(`Could not release idempotency key ${key}: ${describe(error)}`);
    }
  }
}

function contentTypeOf(res: Response): string | null {
  const value = res.getHeader("content-type");
  return typeof value === "string" ? value : null;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
