import { defineSaga } from "./saga-definition";
import { SagaRegistry } from "./saga-registry";
import { SagaDefinitionError, UnknownSagaError } from "./saga.errors";
import type { SagaState } from "./saga-state";

const definition = (name: string) =>
  defineSaga<SagaState>(name, [
    {
      name: "only",
      kind: "compensatable",
      execute: async () => undefined,
      compensate: async () => undefined,
    },
  ]);

describe("SagaRegistry", () => {
  let registry: SagaRegistry;

  beforeEach(() => {
    registry = new SagaRegistry();
  });

  it("serves a definition back by name", () => {
    const saga = definition("order.checkout");
    registry.register(saga);

    expect(registry.find("order.checkout")).toBe(saga);
    expect(registry.require("order.checkout")).toBe(saga);
    expect(registry.names()).toEqual(["order.checkout"]);
  });

  it("resolves null for a name it does not have", () => {
    // Null rather than a throw, because this is the recovery poller's case: an
    // instance whose definition is gone is a row to mark stuck, not an
    // exception to propagate out of a batch.
    expect(registry.find("order.nothing")).toBeNull();
  });

  it("throws for a name it does not have, when the caller cannot proceed without one", () => {
    expect(() => registry.require("order.nothing")).toThrow(UnknownSagaError);
  });

  it("refuses to register the same name twice", () => {
    // Two definitions under one name means half the running instances resolve
    // to steps nobody meant them to run.
    registry.register(definition("order.checkout"));
    expect(() => registry.register(definition("order.checkout"))).toThrow(SagaDefinitionError);
  });
});
