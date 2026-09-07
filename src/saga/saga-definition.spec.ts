import { defineSaga } from "./saga-definition";
import type { SagaStep } from "./saga-definition";
import { SagaDefinitionError } from "./saga.errors";
import type { SagaState } from "./saga-state";

const noop = async () => undefined;

function compensatable(name: string): SagaStep<SagaState> {
  return { name, kind: "compensatable", execute: noop, compensate: noop };
}

function pivot(name: string): SagaStep<SagaState> {
  return { name, kind: "pivot", execute: noop };
}

function retriable(name: string): SagaStep<SagaState> {
  return { name, kind: "retriable", execute: noop };
}

describe("defineSaga", () => {
  it("accepts the canonical shape: compensatable steps, a pivot, then retriable ones", () => {
    const saga = defineSaga("order.checkout", [
      compensatable("accept"),
      compensatable("reserve"),
      pivot("ship"),
      retriable("confirm"),
    ]);

    expect(saga.name).toBe("order.checkout");
    expect(saga.steps.map((step) => step.name)).toEqual(["accept", "reserve", "ship", "confirm"]);
  });

  it("accepts a saga with no pivot at all, which can always be rolled back in full", () => {
    expect(() =>
      defineSaga("all.undoable", [compensatable("one"), compensatable("two")]),
    ).not.toThrow();
  });

  it("refuses a saga with no steps", () => {
    expect(() => defineSaga("empty", [])).toThrow(SagaDefinitionError);
    expect(() => defineSaga("empty", [])).toThrow(/has no steps/);
  });

  it("refuses two steps with the same name, because the name is an idempotency key", () => {
    expect(() => defineSaga("dupe", [compensatable("charge"), compensatable("charge")])).toThrow(
      /declares the step "charge" twice/,
    );
  });

  it("refuses more than one pivot", () => {
    expect(() => defineSaga("two-pivots", [pivot("one"), pivot("two")])).toThrow(
      /more than one pivot/,
    );
  });

  it("refuses a retriable step before the pivot", () => {
    // It would be a step the orchestrator declines to roll back while the saga
    // is still perfectly able to roll back — silent in a happy-path test, wrong
    // the first time anything fails.
    expect(() => defineSaga("early", [retriable("confirm"), pivot("ship")])).toThrow(
      /runs before the pivot, where every step must be compensatable/,
    );
  });

  it("refuses a compensatable step after the pivot", () => {
    // A promise to unwind something past the point of no return.
    expect(() => defineSaga("late", [pivot("ship"), compensatable("confirm")])).toThrow(
      /runs after the pivot, where nothing may be rolled back/,
    );
  });
});
