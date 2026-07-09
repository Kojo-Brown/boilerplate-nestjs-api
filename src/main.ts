import "reflect-metadata";
import { NestFactory, Reflector } from "@nestjs/core";
import { ValidationPipe, VersioningType } from "@nestjs/common";
import { AppModule } from "./app.module";
import { AllExceptionsFilter } from "./common/filters/all-exceptions.filter";
import { ResponseEnvelopeInterceptor } from "./common/interceptors/response-envelope.interceptor";
import { LoggingInterceptor } from "./common/interceptors/logging.interceptor";
import { setupSwagger } from "./common/swagger/setup-swagger";
import { ConfigService } from "@nestjs/config";

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });

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
  app.useGlobalInterceptors(new LoggingInterceptor(), new ResponseEnvelopeInterceptor(reflector));

  app.enableCors({
    origin: config.get("ALLOWED_ORIGINS", "*"),
    credentials: true,
  });

  setupSwagger(app);

  app.enableShutdownHooks();

  await app.listen(port);
  console.log(`API running on http://localhost:${port}/v1`);
  console.log(`Swagger UI  http://localhost:${port}/docs`);
}

void bootstrap();
