import type { INestApplication } from "@nestjs/common";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";

export const BEARER_KEY = "access-token" as const;

export function setupSwagger(app: INestApplication): void {
  const config = new DocumentBuilder()
    .setTitle("Boilerplate NestJS API")
    .setDescription(
      [
        "Production-grade NestJS 11 REST API boilerplate.",
        "",
        "## Authentication",
        "Protected endpoints require a Bearer JWT.",
        "Obtain tokens via `POST /v1/auth/register` or `POST /v1/auth/login`,",
        "then click **Authorize** and paste the `accessToken` value.",
      ].join("\n"),
    )
    .setVersion("1.0")
    .addBearerAuth(
      {
        type: "http",
        scheme: "bearer",
        bearerFormat: "JWT",
        description: "Paste your JWT access token (from login/register response)",
        in: "header",
        name: "Authorization",
      },
      BEARER_KEY,
    )
    .build();

  const document = SwaggerModule.createDocument(app, config);

  SwaggerModule.setup("docs", app, document, {
    swaggerOptions: {
      persistAuthorization: true,
      tagsSorter: "alpha",
      operationsSorter: "alpha",
      docExpansion: "list",
      filter: true,
      showRequestDuration: true,
    },
    customSiteTitle: "NestJS API Docs",
  });
}
