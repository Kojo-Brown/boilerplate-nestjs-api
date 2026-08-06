import { BadGatewayException, HttpException, HttpStatus } from "@nestjs/common";
import type { NotificationChannelName } from "./ports";

/**
 * Channel failures are `HttpException`s so `AllExceptionsFilter` renders them
 * with the right status if one ever reaches a request handler unhandled. In
 * practice `NotificationDispatcher` catches them per channel and turns them
 * into a failure entry on the report, because one dead transport must not fail
 * a notification the other two delivered.
 */
export class NotificationChannelError extends HttpException {
  constructor(
    readonly channel: NotificationChannelName,
    message: string,
    /** The transport's own error code, kept for log correlation. */
    readonly upstreamCode?: string,
    status: HttpStatus = HttpStatus.BAD_GATEWAY,
  ) {
    super({ statusCode: status, message, error: "NotificationChannelError" }, status);
  }
}

/**
 * The transport accepted the request but rejected this specific address —
 * an unregistered device, a disconnected number.
 *
 * Separate from the generic error because the remedy is different: retrying
 * will never help, and the caller should stop storing that address. Still a 502
 * rather than a 400, since the address came from our own records and not from
 * whoever triggered the notification.
 */
export class NotificationAddressRejectedError extends BadGatewayException {
  constructor(
    readonly channel: NotificationChannelName,
    readonly address: string,
    readonly reason: string,
  ) {
    super(`${channel} transport rejected address ${address}: ${reason}`);
  }
}
