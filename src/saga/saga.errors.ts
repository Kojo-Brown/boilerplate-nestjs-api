/**
 * Saga failures are plain errors rather than `HttpException`s, which is the
 * opposite of `src/payments/payment.errors.ts` and deliberate. A saga runs
 * behind the request that started it and, after the first retry, behind no
 * request at all — the recovery poller has nobody to answer with a status code.
 * The one that does reach a client is translated at the edge, in
 * `OrdersController`, from the order's status rather than from an exception.
 */

/** A step that will not succeed however many times it is tried. */
export class UnretryableStepError extends Error {
  constructor(
    message: string,
    /** The error this stands in for, when there was one. Kept for the log. */
    override readonly cause?: unknown,
  ) {
    super(message);
    this.name = "UnretryableStepError";
  }
}

/**
 * A definition that cannot be run as written. Thrown at construction, so it
 * fails the boot rather than the first order.
 */
export class SagaDefinitionError extends Error {
  constructor(saga: string, problem: string) {
    super(`Saga "${saga}" ${problem}.`);
    this.name = "SagaDefinitionError";
  }
}

/**
 * A persisted instance whose definition this build does not have.
 *
 * The counterpart of `UnknownOutboxEventError`: a deploy that renames or
 * retires a saga leaves rows behind that no code can advance. The orchestrator
 * marks them `STUCK` rather than throwing on every poll forever.
 */
export class UnknownSagaError extends Error {
  constructor(readonly saga: string) {
    super(`No saga named "${saga}" is registered. It was removed, or never registered.`);
    this.name = "UnknownSagaError";
  }
}

/**
 * A persisted cursor that no longer names the step it was written against.
 *
 * Reordering or renaming steps in a deploy that leaves running instances behind
 * would otherwise resume a saga into the wrong step — compensating a payment
 * with a call that releases stock, say. The cursor is a position and the log
 * remembers the name, so the two can be checked against each other before
 * anything is called.
 */
export class SagaResumeError extends Error {
  constructor(sagaId: string, problem: string) {
    super(`Saga ${sagaId} cannot be resumed: ${problem}.`);
    this.name = "SagaResumeError";
  }
}

/** A step that did not answer inside `SAGA_STEP_TIMEOUT_MS`. */
export class SagaStepTimeoutError extends Error {
  constructor(step: string, timeoutMs: number) {
    super(`Step "${step}" did not settle within ${timeoutMs}ms.`);
    this.name = "SagaStepTimeoutError";
  }
}
