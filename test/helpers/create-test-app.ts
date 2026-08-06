import { type INestApplication, Module, ValidationPipe, VersioningType } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
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
}

@Module({
  providers: [{ provide: EmailQueueService, useClass: RecordingEmailQueue }],
  exports: [EmailQueueService],
})
class MockQueueModule {}

export interface TestApp {
  app: INestApplication;
  prisma: InMemoryPrismaService;
}

export async function createTestApp(): Promise<TestApp> {
  const prisma = new InMemoryPrismaService();

  const moduleFixture = await Test.createTestingModule({
    imports: [AppModule],
  })
    .overrideModule(QueueModule)
    .useModule(MockQueueModule)
    .overrideProvider(PrismaService)
    .useValue(prisma)
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

  app.enableVersioning({ type: VersioningType.URI, defaultVersion: "1" });
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
    }),
  );

  const reflector = app.get(Reflector);
  app.useGlobalFilters(new AllExceptionsFilter());
  app.useGlobalInterceptors(new LoggingInterceptor(), new ResponseEnvelopeInterceptor(reflector));

  await app.init();

  return { app, prisma };
}
