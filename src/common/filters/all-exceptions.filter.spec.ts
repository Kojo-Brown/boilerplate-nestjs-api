import { HttpException, HttpStatus } from "@nestjs/common";
import type { ArgumentsHost } from "@nestjs/common";
import { AllExceptionsFilter } from "./all-exceptions.filter";

function buildHost(url = "/test") {
  const json = jest.fn();
  const status = jest.fn().mockReturnValue({ json });
  const getResponse = jest.fn().mockReturnValue({ status });
  const getRequest = jest.fn().mockReturnValue({ url });
  const host = {
    switchToHttp: jest.fn().mockReturnValue({ getResponse, getRequest }),
  } as unknown as ArgumentsHost;
  return { host, json, status };
}

describe("AllExceptionsFilter", () => {
  let filter: AllExceptionsFilter;

  beforeEach(() => {
    filter = new AllExceptionsFilter();
  });

  it("handles an HttpException with a string response", () => {
    const { host, status, json } = buildHost("/api/test");
    const exception = new HttpException("Not Found", HttpStatus.NOT_FOUND);

    filter.catch(exception, host);

    expect(status).toHaveBeenCalledWith(HttpStatus.NOT_FOUND);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({
        statusCode: HttpStatus.NOT_FOUND,
        path: "/api/test",
      }),
    );
  });

  it("handles an HttpException with an object response body", () => {
    const { host, status, json } = buildHost("/api/register");
    const exception = new HttpException(
      { message: ["email must be valid"], error: "Bad Request" },
      HttpStatus.BAD_REQUEST,
    );

    filter.catch(exception, host);

    expect(status).toHaveBeenCalledWith(HttpStatus.BAD_REQUEST);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({
        statusCode: HttpStatus.BAD_REQUEST,
        message: ["email must be valid"],
        error: "Bad Request",
      }),
    );
  });

  it("handles a non-HttpException as 500 InternalServerError", () => {
    const { host, status, json } = buildHost("/api/crash");

    filter.catch(new Error("Unexpected crash"), host);

    expect(status).toHaveBeenCalledWith(HttpStatus.INTERNAL_SERVER_ERROR);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({
        statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
        message: "Internal server error",
        error: "InternalServerError",
        path: "/api/crash",
      }),
    );
  });

  it("handles a non-Error thrown value", () => {
    const { host, status } = buildHost("/api/wtf");

    filter.catch("just a string error", host);

    expect(status).toHaveBeenCalledWith(HttpStatus.INTERNAL_SERVER_ERROR);
  });

  it("includes a timestamp string in the response body", () => {
    const { host, json } = buildHost();
    const exception = new HttpException("Conflict", HttpStatus.CONFLICT);

    filter.catch(exception, host);

    const body = (json.mock.calls[0] as [Record<string, unknown>])[0];
    expect(typeof body.timestamp).toBe("string");
    expect(() => new Date(body.timestamp as string)).not.toThrow();
  });
});
