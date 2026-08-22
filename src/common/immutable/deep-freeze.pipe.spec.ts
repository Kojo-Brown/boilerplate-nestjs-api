import type { ArgumentMetadata } from "@nestjs/common";
import { DeepFreezePipe, freezingEnabledFor } from "./deep-freeze.pipe";

class UpdateThingDto {
  name?: string;
  nested: { theme: string } = { theme: "dark" };
}

const meta = (over: Partial<ArgumentMetadata> = {}): ArgumentMetadata => ({
  type: "body",
  metatype: UpdateThingDto,
  data: undefined,
  ...over,
});

describe("DeepFreezePipe", () => {
  const pipe = new DeepFreezePipe(true);

  it("freezes a validated DTO all the way down", () => {
    const dto = pipe.transform(new UpdateThingDto(), meta()) as UpdateThingDto;

    expect(() => {
      dto.name = "changed";
    }).toThrow(TypeError);
    expect(Object.isFrozen(dto.nested)).toBe(true);
  });

  it("returns the same instance rather than a frozen copy", () => {
    const dto = new UpdateThingDto();
    expect(pipe.transform(dto, meta())).toBe(dto);
  });

  it("freezes query and param DTOs too", () => {
    for (const type of ["query", "param"] as const) {
      const dto = pipe.transform(new UpdateThingDto(), meta({ type })) as UpdateThingDto;
      expect(Object.isFrozen(dto)).toBe(true);
    }
  });

  describe("values the framework owns", () => {
    it("never touches a custom parameter", () => {
      // `@Req()`, `@Res()`, `@UploadedFile()` and every custom decorator such
      // as `@CurrentUser()` arrive as `type: "custom"`. Freezing an Express
      // request or response would break the framework outright: both are
      // mutated throughout the request lifecycle.
      const request = { url: "/v1/users", params: {}, headers: {} };
      const returned = pipe.transform(request, meta({ type: "custom", metatype: Object }));

      expect(returned).toBe(request);
      expect(Object.isFrozen(request)).toBe(false);
    });

    it("never touches a natively typed parameter", () => {
      // `@Param("id") id: string` and an untyped `@Query()` both mean the value
      // is whatever Express built and may reuse — `req.query`/`req.params` —
      // rather than an instance `ValidationPipe` just produced.
      const rawQuery = { search: "jane" };
      pipe.transform(rawQuery, meta({ type: "query", metatype: Object }));
      expect(Object.isFrozen(rawQuery)).toBe(false);

      const rawArray = [1, 2];
      pipe.transform(rawArray, meta({ type: "query", metatype: Array }));
      expect(Object.isFrozen(rawArray)).toBe(false);
    });

    it("does nothing when the parameter has no metatype at all", () => {
      const value = { anything: true };
      pipe.transform(value, meta({ metatype: undefined }));
      expect(Object.isFrozen(value)).toBe(false);
    });
  });

  it("is inert when disabled", () => {
    const dto = new UpdateThingDto();
    expect(new DeepFreezePipe(false).transform(dto, meta())).toBe(dto);
    expect(Object.isFrozen(dto)).toBe(false);
  });
});

describe("freezingEnabledFor", () => {
  it("is on everywhere but production", () => {
    expect(freezingEnabledFor("development")).toBe(true);
    expect(freezingEnabledFor("test")).toBe(true);
    // Off in production: there the traversal is cost against a guarantee
    // `DeepReadonly` already gives at compile time, and turning a latent
    // mutation into a thrown TypeError would make a subtly wrong response a 500.
    expect(freezingEnabledFor("production")).toBe(false);
  });

  it("defaults to on when NODE_ENV is unset", () => {
    // Matches the env schema, which defaults NODE_ENV to "development".
    expect(freezingEnabledFor(undefined)).toBe(true);
  });
});
