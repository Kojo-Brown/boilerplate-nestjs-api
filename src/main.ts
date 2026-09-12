// First, ahead of everything including `reflect-metadata`. Importing this
// installs the OpenTelemetry SDK, and the HTTP and Express instrumentations
// work by patching those modules as they are required — so anything loaded
// before this line is loaded uninstrumented. See src/telemetry/register.ts.
import { telemetry } from "./telemetry/register";
import "reflect-metadata";
import { NestFactory, Reflector } from "@nestjs/core";
import { Logger, ValidationPipe, VersioningType } from "@nestjs/common";
import { AppModule } from "./app.module";
import { AllExceptionsFilter } from "./common/filters/all-exceptions.filter";
import { ResponseEnvelopeInterceptor } from "./common/interceptors/response-envelope.interceptor";
import { LoggingInterceptor } from "./common/interceptors/logging.interceptor";
import { IdempotencyInterceptor } from "./common/idempotency";
import { EntityTagInterceptor } from "./common/concurrency";
import { DeepFreezePipe, freezingEnabledFor } from "./common/immutable";
import { setupSwagger } from "./common/swagger/setup-swagger";
import { ConfigService } from "@nestjs/config";
import { WsAdapter } from "@nestjs/platform-ws";
import { TelemetryLogger } from "./telemetry";

const SHUTDOWN_TIMEOUT_MS = 10_000;

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  // What `bufferLogs: true` was always for: the buffered lines are replayed
  // through this logger, so the boot sequence reaches the logs pipeline too
  // rather than only the lines written once the application is up.
  // `TelemetryLogger` is the stock `ConsoleLogger` plus an OpenTelemetry log
  // record per line, and degrades to exactly the stock one when the SDK is off.
  app.useLogger(new TelemetryLogger());
  const logger = new Logger("Bootstrap");

  const config = app.get(ConfigService);
  const port = config.get<number>("PORT", 4000);

  app.enableVersioning({ type: VersioningType.URI, defaultVersion: "1" });

  // Before anything that triggers `init()`. Nest's `SocketModule` picks the
  // adapter up while connecting gateways, and its default is to `require`
  // `@nestjs/platform-socket.io` — which this project does not install, so a
  // missing line here is a boot failure rather than a quietly dead endpoint.
  // `WsAdapter` shares the HTTP server above, so `/v1/realtime` upgrades on the
  // same port as every REST route and needs no second listener.
  app.useWebSocketAdapter(new WsAdapter(app));

  // `DeepFreezePipe` is bound after `ValidationPipe`, and global pipes run in
  // the order they are registered: it must freeze the DTO instance
  // `class-transformer` produces, not the plain body that `ValidationPipe` is
  // about to replace. Outside production only — see docs/immutability.md.
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
    }),
    new DeepFreezePipe(freezingEnabledFor(config.get<string>("NODE_ENV"))),
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
    void app
      .close()
      // After `app.close()`, not before and not in parallel: shutdown hooks are
      // where the outbox relay finishes its last drain and the consumer leaves
      // its group, and both of those produce spans and log records. Flushing
      // first would export everything except the part of the lifecycle that is
      // hardest to observe any other way. Never rejects — see `TelemetryHandle`.
      .then(() => {
        logger.log(`Application closed cleanly on ${signal}`);
        return telemetry.shutdown();
      })
      .then(() => process.exit(0));
  };

  process.once("SIGTERM", () => forceExit("SIGTERM"));
  process.once("SIGINT", () => forceExit("SIGINT"));

  await app.listen(port);
  logger.log(`API running on http://localhost:${port}/v1`);
  logger.log(`Swagger UI  http://localhost:${port}/docs`);
}

void bootstrap();
