import { HttpException, HttpStatus } from "@nestjs/common";

/**
 * A conditional write whose `If-Match` did not hold.
 *
 * A plain `Error`, not an `HttpException`: it is raised by the storage adapter,
 * which has no business naming a status code — the same conflict reached over a
 * message consumer or a CLI is not a "412". `UsersService` translates it at the
 * boundary. It carries the version the row was actually at so the translation
 * can say what the caller should re-read, rather than only that it lost.
 */
export class VersionConflictError extends Error {
  constructor(readonly currentVersion: number) {
    super(`Version conflict — the resource is at version ${currentVersion}`);
    this.name = "VersionConflictError";
  }
}

/**
 * 428, for a mutating request that sent no `If-Match`.
 *
 * RFC 6585 §3 defines this status for exactly this case: the server requires
 * the request to be conditional "to prevent the 'lost update' problem, where a
 * client GETs a resource's state, modifies it and PUTs it back to the server,
 * when meanwhile a third party has modified the state on the server, leading to
 * a conflict". Nest ships no exception class for it.
 */
export class PreconditionRequiredException extends HttpException {
  constructor(message: string) {
    super(
      {
        statusCode: HttpStatus.PRECONDITION_REQUIRED,
        message,
        error: "PreconditionRequired",
      },
      HttpStatus.PRECONDITION_REQUIRED,
    );
  }
}
