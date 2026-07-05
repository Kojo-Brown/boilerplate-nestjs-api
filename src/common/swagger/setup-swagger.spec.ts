import "reflect-metadata";
import type { INestApplication } from "@nestjs/common";
import { SwaggerModule } from "@nestjs/swagger";
import { setupSwagger, BEARER_KEY } from "./setup-swagger";
import { ApiJwtAuth } from "./api-jwt-auth.decorator";
import { ApiCommonErrors, ApiNotFound, ApiConflict, ApiForbiddenRole } from "./api-error-responses.decorator";

describe("setupSwagger", () => {
  let createSpy: jest.SpyInstance;
  let setupSpy: jest.SpyInstance;

  beforeEach(() => {
    createSpy = jest
      .spyOn(SwaggerModule, "createDocument")
      .mockReturnValue({} as ReturnType<typeof SwaggerModule.createDocument>);
    setupSpy = jest.spyOn(SwaggerModule, "setup").mockImplementation(() => {});
  });

  afterEach(() => {
    createSpy.mockRestore();
    setupSpy.mockRestore();
  });

  it("calls SwaggerModule.createDocument once", () => {
    setupSwagger({} as INestApplication);
    expect(createSpy).toHaveBeenCalledTimes(1);
  });

  it("mounts the docs at the /docs path", () => {
    const app = {} as INestApplication;
    setupSwagger(app);
    expect(setupSpy).toHaveBeenCalledWith("docs", app, {}, expect.any(Object));
  });

  it("enables persistAuthorization in swaggerOptions", () => {
    const app = {} as INestApplication;
    setupSwagger(app);
    expect(setupSpy).toHaveBeenCalledWith(
      "docs",
      app,
      {},
      expect.objectContaining({
        swaggerOptions: expect.objectContaining({ persistAuthorization: true }),
      }),
    );
  });
});

describe("BEARER_KEY", () => {
  it('equals "access-token"', () => {
    expect(BEARER_KEY).toBe("access-token");
  });
});

describe("ApiJwtAuth", () => {
  it("returns a decorator function", () => {
    expect(typeof ApiJwtAuth()).toBe("function");
  });

  it("can be applied to a class without throwing", () => {
    expect(() => {
      @ApiJwtAuth()
      class _Ctrl {}
    }).not.toThrow();
  });

  it("can be applied to a method without throwing", () => {
    expect(() => {
      class _Ctrl {
        @ApiJwtAuth()
        action() {}
      }
    }).not.toThrow();
  });
});

describe("ApiCommonErrors", () => {
  it("returns a decorator function", () => {
    expect(typeof ApiCommonErrors()).toBe("function");
  });
});

describe("ApiNotFound", () => {
  it("returns a decorator function with the default label", () => {
    expect(typeof ApiNotFound()).toBe("function");
  });

  it("accepts a custom entity label", () => {
    expect(typeof ApiNotFound("User")).toBe("function");
  });
});

describe("ApiConflict", () => {
  it("returns a decorator function", () => {
    expect(typeof ApiConflict()).toBe("function");
  });
});

describe("ApiForbiddenRole", () => {
  it("returns a decorator function", () => {
    expect(typeof ApiForbiddenRole()).toBe("function");
  });
});
