import { Controller, Get, Patch } from "@nestjs/common";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import type { OpenAPIObject } from "@nestjs/swagger";
import type {
  OperationObject,
  ParameterObject,
} from "@nestjs/swagger/dist/interfaces/open-api-spec.interface";
import { Test } from "@nestjs/testing";
import { ApiConditionalWrite, ApiEntityTag } from "./concurrency.openapi";

@Controller("widgets")
class DocumentedController {
  @Get(":id")
  @ApiEntityTag()
  read() {
    return null;
  }

  @Patch(":id")
  @ApiConditionalWrite()
  write() {
    return null;
  }

  @Patch(":id/optional")
  @ApiConditionalWrite({ required: false })
  writeOptionally() {
    return null;
  }
}

async function buildDocument(): Promise<OpenAPIObject> {
  const moduleRef = await Test.createTestingModule({
    controllers: [DocumentedController],
  }).compile();
  const app = moduleRef.createNestApplication();
  await app.init();

  try {
    return SwaggerModule.createDocument(app, new DocumentBuilder().build());
  } finally {
    await app.close();
  }
}

const headerNamed = (operation: OperationObject | undefined, name: string) =>
  (operation?.parameters as ParameterObject[] | undefined)?.find(
    (parameter) => parameter.name === name && parameter.in === "header",
  );

describe("concurrency OpenAPI decorators", () => {
  let document: OpenAPIObject;

  beforeAll(async () => {
    document = await buildDocument();
  });

  const operation = (path: string, method: "get" | "patch") => document.paths[path]?.[method];

  it("documents the ETag a read hands back", () => {
    expect(headerNamed(operation("/widgets/{id}", "get"), "ETag")).toBeDefined();
  });

  it("documents If-Match on a conditional write", () => {
    expect(headerNamed(operation("/widgets/{id}", "patch"), "If-Match")).toMatchObject({
      required: true,
    });
  });

  it("documents the ETag on a conditional write too, since it returns a new one", () => {
    // A client that cannot see the response validator has to re-read before
    // every subsequent write.
    expect(headerNamed(operation("/widgets/{id}", "patch"), "ETag")).toBeDefined();
  });

  it("documents 412 as an outcome of a conditional write", () => {
    expect(operation("/widgets/{id}", "patch")?.responses["412"]).toBeDefined();
  });

  it("documents 428 only where the header is actually required", () => {
    // Advertising a status the route cannot produce is how a generated client
    // grows a branch that never runs.
    expect(operation("/widgets/{id}", "patch")?.responses["428"]).toBeDefined();
    expect(operation("/widgets/{id}/optional", "patch")?.responses["428"]).toBeUndefined();
  });

  it("marks If-Match optional where the route does not demand it", () => {
    expect(headerNamed(operation("/widgets/{id}/optional", "patch"), "If-Match")).toMatchObject({
      required: false,
    });
  });

  it("still documents 412 on an optional conditional write", () => {
    // Optional means the client may omit the header, not that sending a stale
    // one is forgiven.
    expect(operation("/widgets/{id}/optional", "patch")?.responses["412"]).toBeDefined();
  });
});
