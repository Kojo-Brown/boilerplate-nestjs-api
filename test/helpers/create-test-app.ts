import { type INestApplication, Module, ValidationPipe, VersioningType } from "@nestjs/common";
import { APP_GUARD, Reflector } from "@nestjs/core";
import { Test } from "@nestjs/testing";
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
    .overrideProvider(APP_GUARD)
    .useValue({ canActivate: () => true })
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
