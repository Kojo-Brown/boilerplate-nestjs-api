import { BadRequestException, HttpStatus } from "@nestjs/common";
import type { Request } from "express";
import { requireConditional, resolveIfMatch } from "./if-match.decorator";
import { PreconditionRequiredException } from "./concurrency.exceptions";
import { UNCONDITIONAL, parseIfMatch } from "./entity-tag";

const requestWith = (headers: Request["headers"]): Pick<Request, "headers"> => ({ headers });

describe("resolveIfMatch()", () => {
  it("parses a strong entity-tag", () => {
    expect(resolveIfMatch(requestWith({ "if-match": '"3"' }))).toEqual({
      mode: "list",
      tags: [{ weak: false, opaque: "3", version: 3 }],
    });
  });

  it("parses `*`", () => {
    expect(resolveIfMatch(requestWith({ "if-match": "*" }))).toEqual({ mode: "any" });
  });

  it("reports an absent header as unconditional rather than refusing it", () => {
    // Refusing here would put 428 ahead of validation and authorization; see
    // `requireConditional`.
    expect(resolveIfMatch(requestWith({}))).toBe(UNCONDITIONAL);
  });

  it("rejects a malformed header rather than treating it as absent", () => {
    // Silently downgrading to unconditional here is how a typo turns a
    // protected write into an unprotected one.
    expect(() => resolveIfMatch(requestWith({ "if-match": "3" }))).toThrow(BadRequestException);
  });

  it("rejects a header that arrived as an array", () => {
    expect(() =>
      resolveIfMatch(requestWith({ "if-match": ['"3"', '"4"'] } as unknown as Request["headers"])),
    ).toThrow(BadRequestException);
  });
});

describe("requireConditional()", () => {
  it("passes through a request that named a version", () => {
    expect(() => requireConditional(parseIfMatch('"3"'))).not.toThrow();
  });

  it("passes through `*`", () => {
    expect(() => requireConditional(parseIfMatch("*"))).not.toThrow();
  });

  it("passes through a tag that cannot match — that is a 412, not a 428", () => {
    expect(() => requireConditional(parseIfMatch('"9f8b2c"'))).not.toThrow();
  });

  it("refuses an unconditional write", () => {
    expect(() => requireConditional(UNCONDITIONAL)).toThrow(PreconditionRequiredException);
  });

  it("answers 428, the status RFC 6585 defines for the lost-update problem", () => {
    try {
      requireConditional(UNCONDITIONAL);
      throw new Error("expected a rejection");
    } catch (error) {
      expect((error as PreconditionRequiredException).getStatus()).toBe(
        HttpStatus.PRECONDITION_REQUIRED,
      );
    }
  });

  it("tells the caller how to obtain a validator", () => {
    // A bare 428 leaves a client with no way to comply.
    expect(() => requireConditional(UNCONDITIONAL)).toThrow(/ETag/);
  });
});
