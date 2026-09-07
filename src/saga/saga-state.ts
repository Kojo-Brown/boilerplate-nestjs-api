/**
 * A saga's state is the only thing that survives between its steps, and it
 * survives in a `jsonb` column — so it is JSON, and saying so in the type
 * system is what stops a `Date`, a `Map` or a Prisma row being put in it and
 * coming back as something else entirely three minutes later.
 */
export type JsonValue =
  string | number | boolean | null | readonly JsonValue[] | { readonly [key: string]: JsonValue };

/**
 * What a saga knows, carried from step to step.
 *
 * Declare a concrete state as a **type alias**, never an interface:
 *
 * ```ts
 * type CheckoutSagaState = { orderId: string; paymentId: string | null };
 * ```
 *
 * TypeScript gives a type alias an implicit index signature and an interface
 * none, so only the alias is assignable to this. That is a language quirk
 * rather than a design decision, but it is load-bearing here and silently
 * breaking it produces an error message about index signatures that says
 * nothing about sagas.
 *
 * Fields are `T | null` rather than optional, for the reason
 * `UserRegisteredPayload.name` is: this object is serialised and read back, and
 * "absent" and "explicitly null" are different bytes. A step that has not run
 * yet leaves its output `null`; a step that has run sets it. `undefined` would
 * come back as absent and make "not yet" and "never" indistinguishable.
 */
export type SagaState = { readonly [key: string]: JsonValue };

/**
 * What a step contributes to the state when it succeeds.
 *
 * A patch rather than a mutation, and the difference matters: the orchestrator
 * writes the new state and the new cursor in one statement, so a step that had
 * mutated a shared object would have already changed the state the row still
 * says belongs to the previous cursor. Returning a patch keeps "what the step
 * learned" and "the step is done" atomic.
 */
export type SagaStatePatch<S extends SagaState> = Partial<S>;
