import { firstValueFrom, of } from "rxjs";
import type { CallHandler, ExecutionContext } from "@nestjs/common";
import { EntityTagInterceptor } from "./entity-tag.interceptor";
import { VERSIONED_RESOURCE_MARKER, isVersionedResource, versioned } from "./versioned-resource";

function contextFor(type: "http" | "rpc" = "http") {
  const setHeader = jest.fn();
  const context = {
    getType: () => type,
    switchToHttp: () => ({ getResponse: () => ({ setHeader }) }),
  } as unknown as ExecutionContext;
  return { context, setHeader };
}

const handlerReturning = (value: unknown): CallHandler => ({ handle: () => of(value) });

describe("EntityTagInterceptor", () => {
  const interceptor = new EntityTagInterceptor();

  it("sets a strong ETag from the wrapped version", async () => {
    const { context, setHeader } = contextFor();

    await firstValueFrom(
      interceptor.intercept(context, handlerReturning(versioned({ id: "u1" }, 3))),
    );

    expect(setHeader).toHaveBeenCalledWith("ETag", '"3"');
  });

  it("unwraps, so nothing downstream sees the wrapper", async () => {
    const { context } = contextFor();
    const body = { id: "u1" };

    const emitted = await firstValueFrom(
      interceptor.intercept(context, handlerReturning(versioned(body, 3))),
    );

    expect(emitted).toBe(body);
  });

  it("sets an ETag for version 0, which is falsy and easy to lose", async () => {
    const { context, setHeader } = contextFor();

    await firstValueFrom(
      interceptor.intercept(context, handlerReturning(versioned({ id: "u1" }, 0))),
    );

    expect(setHeader).toHaveBeenCalledWith("ETag", '"0"');
  });

  it("passes an unwrapped payload through untouched", async () => {
    const { context, setHeader } = contextFor();
    const body = { id: "u1" };

    const emitted = await firstValueFrom(interceptor.intercept(context, handlerReturning(body)));

    expect(emitted).toBe(body);
    expect(setHeader).not.toHaveBeenCalled();
  });

  it("attaches no ETag to a payload that merely has a `version` field", async () => {
    // Deliberately not inferred from the payload: a payment intent's API
    // version is not a validator, and an ETag the server never minted invites a
    // conditional write it cannot honour.
    const { context, setHeader } = contextFor();

    await firstValueFrom(
      interceptor.intercept(context, handlerReturning({ id: "pi_1", version: 7 })),
    );

    expect(setHeader).not.toHaveBeenCalled();
  });

  it("leaves a non-HTTP context alone", async () => {
    const { context, setHeader } = contextFor("rpc");

    await firstValueFrom(
      interceptor.intercept(context, handlerReturning(versioned({ id: "u1" }, 3))),
    );

    expect(setHeader).not.toHaveBeenCalled();
  });

  it("recognises a wrapper that has been through a cache round trip", async () => {
    // `HttpCacheInterceptor` is bound inside this one, so on a cache hit the
    // value arrives as whatever the store gave back — JSON, in any deployment
    // with Redis. A marker that did not survive that would silently drop the
    // ETag from every cached read.
    const { context, setHeader } = contextFor();
    const revived: unknown = JSON.parse(JSON.stringify(versioned({ id: "u1" }, 3)));

    await firstValueFrom(interceptor.intercept(context, handlerReturning(revived)));

    expect(setHeader).toHaveBeenCalledWith("ETag", '"3"');
  });
});

describe("isVersionedResource()", () => {
  it("accepts a wrapper", () => {
    expect(isVersionedResource(versioned({}, 1))).toBe(true);
  });

  it.each([
    ["null", null],
    ["undefined", undefined],
    ["a string", "versioned"],
    ["a number", 3],
    ["a bare object", { version: 1 }],
    ["a marker without a version", { [VERSIONED_RESOURCE_MARKER]: true }],
    ["a non-numeric version", { [VERSIONED_RESOURCE_MARKER]: true, version: "3" }],
    ["a falsy marker", { [VERSIONED_RESOURCE_MARKER]: false, version: 1 }],
  ])("rejects %s", (_case, value) => {
    expect(isVersionedResource(value)).toBe(false);
  });
});
