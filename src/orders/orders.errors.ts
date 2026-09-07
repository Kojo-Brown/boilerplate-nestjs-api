import { ForbiddenException, NotFoundException } from "@nestjs/common";

/**
 * The two participant failures below are plain errors, not `HttpException`s.
 *
 * They are raised inside saga steps, and a saga step usually has no request to
 * answer — after the first retry it is running behind a poller. What the
 * customer sees is the order's `status` and `failureReason`, written by the
 * compensation, rather than a status code thrown from three services away. The
 * two that *are* HTTP exceptions are the ones raised on the request path.
 */

/** The warehouse cannot hold what was asked for. Permanent: the shelf is empty. */
export class OutOfStockError extends Error {
  constructor(
    readonly sku: string,
    readonly requested: number,
    readonly available: number,
  ) {
    super(`Only ${available} of "${sku}" available, ${requested} requested`);
    this.name = "OutOfStockError";
  }
}

/** No carrier covers the destination. Permanent: waiting will not add one. */
export class UnservicedDestinationError extends Error {
  constructor(readonly destination: string) {
    super(`No carrier serves "${destination}"`);
    this.name = "UnservicedDestinationError";
  }
}

/** The order does not exist, or belongs to somebody else — see `OrdersController`. */
export class OrderNotFoundError extends NotFoundException {
  constructor(id: string) {
    super(`Order ${id} not found`);
  }
}

/**
 * Somebody else's order.
 *
 * Raised only where a 404 would be worse: the caller has already been told the
 * order exists by some other route. The read path returns
 * {@link OrderNotFoundError} instead, so an id is not a membership oracle.
 */
export class OrderAccessDeniedError extends ForbiddenException {
  constructor(id: string) {
    super(`Order ${id} does not belong to you`);
  }
}
