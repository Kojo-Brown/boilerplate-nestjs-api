import { type INestApplication, Module, ValidationPipe, VersioningType } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { Test } from "@nestjs/testing";
import { ThrottlerStorage } from "@nestjs/throttler";
import type { ThrottlerStorageRecord } from "@nestjs/throttler/dist/throttler-storage-record.interface";
import { AppModule } from "@/app.module";
import { QueueModule } from "@/queue/queue.module";
import { PrismaService } from "@/common/prisma/prisma.service";
import { AllExceptionsFilter } from "@/common/filters/all-exceptions.filter";
import { ResponseEnvelopeInterceptor } from "@/common/interceptors/response-envelope.interceptor";
import { LoggingInterceptor } from "@/common/interceptors/logging.interceptor";
import { InMemoryPrismaService } from "./in-memory-prisma";

@Module({})
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
