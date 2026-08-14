import "reflect-metadata";
import { NestFactory, Reflector } from "@nestjs/core";
import { Logger, ValidationPipe, VersioningType } from "@nestjs/common";
import { AppModule } from "./app.module";
import { AllExceptionsFilter } from "./common/filters/all-exceptions.filter";
import { ResponseEnvelopeInterceptor } from "./common/interceptors/response-envelope.interceptor";
import { LoggingInterceptor } from "./common/interceptors/logging.interceptor";
import { IdempotencyInterceptor } from "./common/idempotency";
import { EntityTagInterceptor } from "./common/concurrency";
import { setupSwagger } from "./common/swagger/setup-swagger";
import { ConfigService } from "@nestjs/config";

const SHUTDOWN_TIMEOUT_MS = 10_000;

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  const logger = new Logger("Bootstrap");

  const config = app.get(ConfigService);
  const port = config.get<number>("PORT", 4000);

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
  // Order is load-bearing. Logging is outermost so a replayed request still
  // gets a correlation id and an access-log line. Idempotency sits above the
  // envelope because a replay must be written verbatim rather than handed back
  // to the serialiser — and because what it records is read off `res`, after
  // every interceptor, pipe and filter has had its turn. The entity-tag
  // interceptor is innermost, so it unwraps a versioned result and sets `ETag`
  // before the envelope wraps it: nothing further out has to know that some
  // handlers return a version alongside their payload.
  app.useGlobalInterceptors(
    new LoggingInterceptor(),
    app.get(IdempotencyInterceptor),
    new ResponseEnvelopeInterceptor(reflector),
    new EntityTagInterceptor(),
  );

  app.enableCors({
    origin: config.get("ALLOWED_ORIGINS", "*"),
    credentials: true,
  });

  setupSwagger(app);

  // NestJS lifecycle hooks (OnApplicationShutdown) on SIGTERM/SIGINT
  app.enableShutdownHooks();

  // Force-exit if graceful shutdown exceeds the timeout
  const forceExit = (signal: string) => {
    const timer = setTimeout(() => {
      logger.error(`Graceful shutdown timed out after ${SHUTDOWN_TIMEOUT_MS}ms — forcing exit`);
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    // Allow the process to exit normally if shutdown completes before the timer
    timer.unref();
    void app.close().then(() => {
      logger.log(`Application closed cleanly on ${signal}`);
      process.exit(0);
    });
  };

  process.once("SIGTERM", () => forceExit("SIGTERM"));
  process.once("SIGINT", () => forceExit("SIGINT"));

  await app.listen(port);
  logger.log(`API running on http://localhost:${port}/v1`);
  logger.log(`Swagger UI  http://localhost:${port}/docs`);
}

void bootstrap();
