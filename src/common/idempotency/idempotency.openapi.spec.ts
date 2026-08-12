import type { OpenAPIObject } from "@nestjs/swagger";
import { documentIdempotency } from "./idempotency.openapi";

function documentWith(paths: OpenAPIObject["paths"]): OpenAPIObject {
  return { openapi: "3.1.0", info: { title: "t", version: "1" }, paths } as OpenAPIObject;
}

describe("documentIdempotency", () => {
  it("advertises the header on every mutating operation", () => {
    const document = documentWith({
      "/v1/users": { post: { responses: {} }, get: { responses: {} } },
      "/v1/users/{id}": {
        patch: { responses: {} },
        put: { responses: {} },
        delete: { responses: {} },
      },
    });

    documentIdempotency(document);

    for (const [path, method] of [
      ["/v1/users", "post"],
      ["/v1/users/{id}", "patch"],
      ["/v1/users/{id}", "put"],
      ["/v1/users/{id}", "delete"],
    ] as const) {
      expect(document.paths[path]?.[method]?.parameters).toContainEqual(
        expect.objectContaining({ name: "Idempotency-Key", in: "header" }),
      );
    }
  });

  it("leaves safe methods alone", () => {
    // Sending the header on a GET does nothing, so advertising it there would
    // document a behaviour the interceptor does not have.
    const document = documentWith({ "/v1/users": { get: { responses: {} } } });

    documentIdempotency(document);

    expect(document.paths["/v1/users"]?.get?.parameters).toBeUndefined();
  });

  it("keeps the parameters a route already declares", () => {
    const document = documentWith({
      "/v1/users/{id}": {
        patch: {
          responses: {},
          parameters: [{ name: "id", in: "path", required: true }],
        },
      },
    });

    documentIdempotency(document);

    expect(document.paths["/v1/users/{id}"]?.patch?.parameters).toHaveLength(2);
  });

  it("does not overwrite a status the route documents itself", () => {
    // A route with its own 422 means something more specific by it than
    // "you reused a key", and its description is the one a reader needs.
    const document = documentWith({
      "/v1/users": {
        post: { responses: { "422": { description: "Validation failed" } } },
      },
    });

    documentIdempotency(document);

    const responses = document.paths["/v1/users"]?.post?.responses;
    expect(responses?.["422"]).toEqual({ description: "Validation failed" });
    expect(responses?.["409"]).toEqual(
      expect.objectContaining({ description: expect.any(String) }),
    );
  });
});
