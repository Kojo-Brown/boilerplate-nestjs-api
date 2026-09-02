import { type INestApplication, Module, ValidationPipe, VersioningType } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { WsAdapter } from "@nestjs/platform-ws";
import { Test } from "@nestjs/testing";
import { ThrottlerStorage } from "@nestjs/throttler";
import type { ThrottlerStorageRecord } from "@nestjs/throttler/dist/throttler-storage-record.interface";
import { AppModule } from "@/app.module";
import { QueueModule } from "@/queue/queue.module";
import { EmailQueueService } from "@/queue/email/email-queue.service";
import { PrismaService } from "@/common/prisma/prisma.service";
import { AllExceptionsFilter } from "@/common/filters/all-exceptions.filter";
import { ResponseEnvelopeInterceptor } from "@/common/interceptors/response-envelope.interceptor";
import { LoggingInterceptor } from "@/common/interceptors/logging.interceptor";
import { IdempotencyInterceptor } from "@/common/idempotency";
import { EntityTagInterceptor } from "@/common/concurrency";
import { DeepFreezePipe, freezingEnabledFor } from "@/common/immutable";
import { REFRESH_TOKEN_STORE } from "@/auth/ports";
import { OUTBOX_STORE, OutboxRelayService } from "@/outbox";
import type { DrainReport } from "@/outbox";
import { InMemoryRefreshTokenStore } from "@/test-utils/in-memory-refresh-token.store";
import { InMemoryOutboxStore } from "@/test-utils/in-memory-outbox.store";
import { InMemoryPrismaService } from "./in-memory-prisma";

/**
 * Stands in for `QueueModule`, so the suite needs no Redis.
 *
 * It has to export `EmailQueueService` rather than be empty: `EmailNotificationChannel`
 * injects it, so an empty module would make `NotificationsModule` — and with
 * it the whole application — fail to instantiate. Recording the enqueued jobs
 * rather than discarding them means an e2e test can assert that an endpoint
 * notified someone.
 */
export class RecordingEmailQueue {
  readonly enqueued: { job: string; data: unknown }[] = [];

  private nextJobId = 0;

  async sendNotificationEmail(data: unknown): Promise<string> {
    this.enqueued.push({ job: "send-notification", data });
    return `test-job-${(this.nextJobId += 1)}`;
  }

  /**
   * Called by `WelcomeEmailListener`, which no endpoint invokes directly — it
   * is subscribed to `user.registered`. A double missing this method would not
   * fail a test: `@OnDomainEvent` contains the `TypeError` and registration
   * still returns 201, which is exactly the failure mode that makes an event
   * bus easy to get wrong and worth asserting on end to end.
   */
  async sendWelcomeEmail(data: unknown): Promise<void> {
    this.enqueued.push({ job: "send-welcome", data });
  }

  reset(): void {
    this.enqueued.length = 0;
  }
}

@Module({
  providers: [{ provide: EmailQueueService, useClass: RecordingEmailQueue }],
  exports: [EmailQueueService],
})
class MockQueueModule {}

export interface TestApp {
  app: INestApplication;
  prisma: InMemoryPrismaService;
  /** The queue the app actually resolved, for asserting on background effects. */
  emails: RecordingEmailQueue;
  /** The refresh-token store the app actually resolved. */
  refreshTokens: InMemoryRefreshTokenStore;
  /** The outbox rows the app has staged, for asserting on what was announced. */
  outbox: InMemoryOutboxStore;
  /**
   * Runs one relay pass and reports it.
   *
   * Staged events reach their subscribers only when the relay delivers them, so
   * a spec asserting on a background effect — a welcome email, say — has to
   * drain first. That is not test scaffolding hiding a problem: it is the
   * latency the outbox trades for durability, made explicit instead of slept
   * through.
   */
  drainOutbox: () => Promise<DrainReport>;
}

export async function createTestApp(): Promise<TestApp> {
  const prisma = new InMemoryPrismaService();
  // `PrismaRefreshTokenStore` claims tokens with `SELECT … FOR UPDATE` in an
  // interactive transaction, neither of which `InMemoryPrismaService` has or
  // could honestly fake — so the port is substituted rather than the client
  // underneath it. Owners are read from the same map the rest of the fake uses,
  // so the join the real adapter performs stays accurate here.
  const refreshTokens = new InMemoryRefreshTokenStore((userId) => prisma._users.get(userId));
  // `PrismaOutboxStore` claims rows with `SELECT … FOR UPDATE SKIP LOCKED` in an
  // interactive transaction, which `InMemoryPrismaService` has no way to fake —
  // so the port is substituted rather than the client underneath it, exactly as
  // the refresh-token store is. Both doubles are held to the same behavioural
  // contracts as the adapters they replace.
  // `TRANSACTION_RUNNER` is deliberately *not* substituted. The real
  // `PrismaTransactionRunner` runs against `InMemoryPrismaService.$transaction`,
  // which keeps `PrismaUsersRepository` — the adapter this suite is here to
  // exercise — writing through a handle it recognises, and keeps the
  // `onRollback` hook the in-memory outbox depends on.
  const outbox = new InMemoryOutboxStore();

  const moduleFixture = await Test.createTestingModule({
    imports: [AppModule],
  })
    .overrideModule(QueueModule)
    .useModule(MockQueueModule)
    .overrideProvider(PrismaService)
    .useValue(prisma)
    .overrideProvider(REFRESH_TOKEN_STORE)
    .useValue(refreshTokens)
    .overrideProvider(OUTBOX_STORE)
    .useValue(outbox)
    // A whole suite makes far more auth calls per minute than any real client,
    // so the rate limiter would 429 every spec after the tenth. The guard itself
    // is registered via `{ provide: APP_GUARD, useClass }` and so cannot be
    // overridden by token; swapping its storage for one that always reports the
    // first hit is the supported way to neutralise it. Limits themselves are
    // asserted in `throttler.guard.spec.ts`.
    .overrideProvider(ThrottlerStorage)
    .useValue({
      increment: async (): Promise<ThrottlerStorageRecord> => ({
        totalHits: 1,
        timeToExpire: 60,
        isBlocked: false,
        timeToBlockExpire: 0,
      }),
    })
    .compile();

  const app = moduleFixture.createNestApplication();

  // Same as main.ts, and for the same reason: `SocketModule` reads the adapter
  // during `init()` below and falls back to `require`-ing
  // `@nestjs/platform-socket.io`, which is not installed. Every e2e suite would
  // fail to boot without this line, not only the one that opens a socket.
  app.useWebSocketAdapter(new WsAdapter(app));

  app.enableVersioning({ type: VersioningType.URI, defaultVersion: "1" });
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
    }),
    // NODE_ENV is "test" here, so freezing is on: the e2e suite is where a
    // handler or interceptor that mutates its own request payload in place
    // should be caught, not production.
    new DeepFreezePipe(freezingEnabledFor(process.env["NODE_ENV"])),
  );

  const reflector = app.get(Reflector);
  app.useGlobalFilters(new AllExceptionsFilter());
  // Same order as main.ts, and for the same reasons — see the comment there.
  // An e2e suite that bound these differently would be testing an application
  // nobody deploys.
  app.useGlobalInterceptors(
    new LoggingInterceptor(),
    app.get(IdempotencyInterceptor),
    new ResponseEnvelopeInterceptor(reflector),
    new EntityTagInterceptor(),
  );

  // `init()` is also what runs `onApplicationBootstrap`, where the event
  // subscriber loader registers every `@OnDomainEvent` method. Without it the
  // app would answer requests with no subscribers attached at all.
  await app.init();

  const relay = app.get(OutboxRelayService);

  return {
    app,
    prisma,
    emails: app.get<RecordingEmailQueue>(EmailQueueService),
    refreshTokens,
    outbox,
    drainOutbox: () => relay.runOnce(),
  };
}
