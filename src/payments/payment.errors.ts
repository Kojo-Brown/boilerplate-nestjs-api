import {
  BadRequestException,
  ConflictException,
  HttpException,
  HttpStatus,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import type { PaymentProviderName } from "./ports";

/**
 * Payment failures are `HttpException`s so `AllExceptionsFilter` renders them
 * with the right status and the caller never sees a bare 500. The alternative —
 * a plain `Error` translated in every controller — is the inline
 * `res.status(500)` this codebase does not do.
 */

/** A configured provider rejected the request, or could not be reached. */
export class PaymentProviderError extends HttpException {
  constructor(
    readonly provider: PaymentProviderName,
    message: string,
    /** The provider's own error code, kept for log correlation. */
    readonly upstreamCode?: string,
    status: HttpStatus = HttpStatus.BAD_GATEWAY,
  ) {
    super({ statusCode: status, message, error: "PaymentProviderError" }, status);
  }
}

/** The requested payment does not exist at the provider. */
export class PaymentNotFoundError extends NotFoundException {
  constructor(
    readonly provider: PaymentProviderName,
    readonly paymentId: string,
  ) {
    super(`Payment ${paymentId} not found at provider "${provider}"`);
  }
}

/** The payment exists but is in the wrong state for the requested transition. */
export class PaymentStateError extends ConflictException {
  constructor(
    readonly provider: PaymentProviderName,
    message: string,
  ) {
    super(message);
  }
}

/** A provider name that is not registered — almost always caller input. */
export class UnknownPaymentProviderError extends BadRequestException {
  constructor(name: string, available: readonly PaymentProviderName[]) {
    super(`Unknown payment provider "${name}". Available: ${available.join(", ")}`);
  }
}

/** A registered provider whose credentials are missing from the environment. */
export class PaymentProviderNotConfiguredError extends ServiceUnavailableException {
  constructor(
    readonly provider: PaymentProviderName,
    requiredEnv: readonly string[],
  ) {
    super(`Payment provider "${provider}" is not configured. Set ${requiredEnv.join(" and ")}.`);
  }
}
