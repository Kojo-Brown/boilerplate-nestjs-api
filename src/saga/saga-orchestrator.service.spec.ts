import { InMemoryTransactionRunner } from "@/test-utils/in-memory-transaction.runner";
import { InMemorySagaStore } from "@/test-utils/in-memory-saga.store";
import { stubConfig } from "@/test-utils/stub-config";
import { defineSaga } from "./saga-definition";
import type { SagaStep, SagaStepContext } from "./saga-definition";
import { SagaOrchestrator } from "./saga-orchestrator.service";
import { SagaRegistry } from "./saga-registry";
import { UnretryableStepError } from "./saga.errors";
import type { SagaInstanceRecord } from "./saga-instance";
import type { SagaState } from "./saga-state";

/** Every knob the orchestrator reads. `stubConfig` does not honour defaults. */
const CONFIG = {
  SAGA_LEASE_MS: 60_000,
  SAGA_STEP_TIMEOUT_MS: 5_000,
  SAGA_BACKOFF_BASE_MS: 1_000,
  SAGA_BACKOFF_MAX_MS: 60_000,
  SAGA_MAX_ATTEMPTS: 3,
};

const SAGA = "test.saga";

/** What each step did, in order, so a spec can assert on the whole trace. */
type Trace = string[];

interface Harness {
  readonly store: InMemorySagaStore;
  readonly orchestrator: SagaOrchestrator;
  readonly trace: Trace;
  start(state?: SagaState): Promise<SagaInstanceRecord>;
}

function harness(
  steps: readonly SagaStep<SagaState>[],
  config: Partial<typeof CONFIG> = {},
): Harness {
  const store = new InMemorySagaStore();
  const registry = new SagaRegistry();
  registry.register(defineSaga(SAGA, steps));
  const orchestrator = new SagaOrchestrator(
    store,
    registry,
    stubConfig({ ...CONFIG, ...config }),
    // Full jitter draws uniformly below the ceiling; pinning the draw is what
    // makes a scheduled retry a number a spec can assert on.
    () => 0.5,
  );
  const transactions = new InMemoryTransactionRunner();

  return {
    store,
    orchestrator,
    trace: [],
    start: (state = {}) => transactions.run((tx) => orchestrator.start(tx, SAGA, state)),
  };
}

/** A step that records what it was called with and returns a patch. */
function step(
  trace: Trace,
  name: string,
  kind: "compensatable" | "pivot" | "retriable" = "compensatable",
  behaviour: {
    execute?: (context: SagaStepContext<SagaState>) => Promise<Partial<SagaState> | void>;
    compensate?: (context: SagaStepContext<SagaState>) => Promise<void>;
  } = {},
): SagaStep<SagaState> {
  const execute = async (context: SagaStepContext<SagaState>) => {
    trace.push(name);
    return behaviour.execute ? behaviour.execute(context) : { [name]: "done" };
  };

  if (kind !== "compensatable") return { name, kind, execute };

  return {
    name,
    kind,
    execute,
    compensate: async (context) => {
      trace.push(`undo:${name}`);
      await behaviour.compensate?.(context);
    },
  };
}

/** A step that fails the first `failures` times it is called, then succeeds. */
function flaky(trace: Trace, name: string, failures: number, error?: Error): SagaStep<SagaState> {
  let calls = 0;
  return step(trace, name, "compensatable", {
    execute: async () => {
      calls += 1;
      if (calls <= failures) throw error ?? new Error(`${name} is unavailable`);
      return { [name]: "done" };
    },
  });
}

describe("SagaOrchestrator", () => {
  describe("going forward", () => {
    it("runs every step in order and completes", async () => {
      const trace: Trace = [];
      const h = harness([step(trace, "one"), step(trace, "two"), step(trace, "three")]);

      const started = await h.start();
      const settled = await h.orchestrator.advance(started.id);

      expect(trace).toEqual(["one", "two", "three"]);
      expect(settled?.status).toBe("COMPLETED");
      expect(settled?.cursor).toBe(3);
    });

    it("accumulates each step's patch into the state", async () => {
      const trace: Trace = [];
      const h = harness([
        step(trace, "one", "compensatable", { execute: async () => ({ from: "one" }) }),
        step(trace, "two", "compensatable", { execute: async () => ({ also: "two" }) }),
      ]);

      const started = await h.start({ seeded: true });
      const settled = await h.orchestrator.advance(started.id);

      expect(settled?.state).toEqual({ seeded: true, from: "one", also: "two" });
    });

    it("drops an undefined in a patch rather than writing a key JSON cannot carry", async () => {
      const trace: Trace = [];
      const h = harness([
        step(trace, "one", "compensatable", {
          execute: async () => ({ set: "value", unset: undefined }),
        }),
      ]);

      const settled = await h.orchestrator.advance((await h.start({ unset: "kept" })).id);

      expect(settled?.state).toEqual({ unset: "kept", set: "value" });
    });

    it("gives a step a key that is stable across attempts and distinct between steps", async () => {
      const keys: string[] = [];
      const trace: Trace = [];
      let attempts = 0;
      const h = harness([
        step(trace, "one", "compensatable", {
          execute: async ({ idempotencyKey }) => {
            keys.push(idempotencyKey);
            attempts += 1;
            if (attempts === 1) throw new Error("try again");
            return {};
          },
        }),
        step(trace, "two", "compensatable", {
          execute: async ({ idempotencyKey }) => {
            keys.push(idempotencyKey);
            return {};
          },
        }),
      ]);

      const started = await h.start();
      await h.orchestrator.advance(started.id);
      await h.orchestrator.advance(started.id, new Date(Date.now() + 60_000));

      expect(keys[0]).toBe(`${started.id}:one`);
      // The retry uses the same key — that is what makes it an idempotency key
      // rather than a request id.
      expect(keys[1]).toBe(keys[0]);
      expect(keys[2]).toBe(`${started.id}:two`);
    });

    it("records one log entry per step, in order", async () => {
      const trace: Trace = [];
      const h = harness([step(trace, "one"), step(trace, "two")]);

      const settled = await h.orchestrator.advance((await h.start()).id);

      expect(settled?.log.map((entry) => [entry.step, entry.direction, entry.outcome])).toEqual([
        ["one", "forward", "completed"],
        ["two", "forward", "completed"],
      ]);
    });
  });

  describe("retrying a step", () => {
    it("schedules the retry on the ladder and stops, without compensating", async () => {
      const trace: Trace = [];
      const h = harness([step(trace, "one"), flaky(trace, "two", 1)]);

      const started = await h.start();
      const now = new Date();
      const settled = await h.orchestrator.advance(started.id, now);

      expect(settled?.status).toBe("RUNNING");
      expect(settled?.cursor).toBe(1);
      expect(settled?.attempts).toBe(1);
      // Half of the first rung — the jitter source is pinned at 0.5.
      expect(settled?.nextAttemptAt.getTime()).toBe(now.getTime() + 500);
      expect(trace).toEqual(["one", "two"]);
    });

    it("refuses to advance a saga that is not due yet", async () => {
      const trace: Trace = [];
      const h = harness([flaky(trace, "one", 1)]);

      const started = await h.start();
      await h.orchestrator.advance(started.id);
      const again = await h.orchestrator.advance(started.id);

      expect(trace).toEqual(["one"]);
      expect(again?.attempts).toBe(1);
    });

    it("resumes the same step, not the next one, once the retry is due", async () => {
      const trace: Trace = [];
      const h = harness([flaky(trace, "one", 1), step(trace, "two")]);

      const started = await h.start();
      await h.orchestrator.advance(started.id);
      const settled = await h.orchestrator.advance(started.id, new Date(Date.now() + 60_000));

      expect(trace).toEqual(["one", "one", "two"]);
      expect(settled?.status).toBe("COMPLETED");
      expect(settled?.attempts).toBe(0);
    });

    it("gives up on a step that never comes back, and says how long it waited", async () => {
      const trace: Trace = [];
      const h = harness(
        [
          step(trace, "one", "compensatable", {
            execute: () => new Promise(() => undefined),
          }),
        ],
        { SAGA_STEP_TIMEOUT_MS: 20 },
      );

      const settled = await h.orchestrator.advance((await h.start()).id);

      expect(settled?.status).toBe("RUNNING");
      expect(settled?.lastError).toMatch(/did not settle within 20ms/);
    });
  });

  describe("compensating", () => {
    it("undoes completed steps in reverse, and the failed step too", async () => {
      const trace: Trace = [];
      const h = harness([
        step(trace, "one"),
        step(trace, "two"),
        step(trace, "three", "compensatable", {
          execute: async () => {
            throw new UnretryableStepError("card declined");
          },
        }),
      ]);

      const settled = await h.orchestrator.advance((await h.start()).id);

      // "three" compensates as well: it threw, but a step that threw may still
      // have half-executed, and asking is the only way to find out.
      expect(trace).toEqual(["one", "two", "three", "undo:three", "undo:two", "undo:one"]);
      expect(settled?.status).toBe("COMPENSATED");
      expect(settled?.cursor).toBe(-1);
      expect(settled?.lastError).toBe("card declined");
    });

    it("turns around immediately on an unretryable failure, spending no attempts", async () => {
      const trace: Trace = [];
      const h = harness([
        step(trace, "one", "compensatable", {
          execute: async () => {
            throw new UnretryableStepError("out of stock");
          },
        }),
      ]);

      const settled = await h.orchestrator.advance((await h.start()).id);

      expect(trace).toEqual(["one", "undo:one"]);
      expect(settled?.status).toBe("COMPENSATED");
      expect(settled?.log.filter((entry) => entry.outcome === "failed")).toHaveLength(1);
    });

    it("compensates only once the ladder is spent, for an ordinary failure", async () => {
      const trace: Trace = [];
      const h = harness([step(trace, "one"), flaky(trace, "two", 99)], { SAGA_MAX_ATTEMPTS: 2 });

      const started = await h.start();
      await h.orchestrator.advance(started.id);
      const settled = await h.orchestrator.advance(started.id, new Date(Date.now() + 60_000));

      expect(trace).toEqual(["one", "two", "two", "undo:two", "undo:one"]);
      expect(settled?.status).toBe("COMPENSATED");
    });

    it("tells a compensation which step failed, and why", async () => {
      const seen: { step: string; message: string }[] = [];
      const trace: Trace = [];
      const h = harness([
        step(trace, "one", "compensatable", {
          compensate: async ({ failure }) => {
            if (failure) seen.push({ ...failure });
          },
        }),
        step(trace, "two", "compensatable", {
          execute: async () => {
            throw new UnretryableStepError("nothing left on the shelf");
          },
          compensate: async ({ failure }) => {
            if (failure) seen.push({ ...failure });
          },
        }),
      ]);

      await h.orchestrator.advance((await h.start()).id);

      expect(seen).toEqual([
        { step: "two", message: "nothing left on the shelf" },
        { step: "two", message: "nothing left on the shelf" },
      ]);
    });

    it("records a skip for the pivot rather than passing over it silently", async () => {
      const trace: Trace = [];
      const h = harness([
        step(trace, "one"),
        step(trace, "pivot", "pivot", {
          execute: async () => {
            throw new UnretryableStepError("no carrier");
          },
        }),
      ]);

      const settled = await h.orchestrator.advance((await h.start()).id);

      expect(trace).toEqual(["one", "pivot", "undo:one"]);
      expect(settled?.log.map((entry) => [entry.step, entry.direction, entry.outcome])).toEqual([
        ["one", "forward", "completed"],
        ["pivot", "forward", "failed"],
        ["pivot", "backward", "skipped"],
        ["one", "backward", "completed"],
      ]);
    });

    it("retries a failing compensation before giving up on it", async () => {
      const trace: Trace = [];
      let undos = 0;
      const h = harness([
        step(trace, "one", "compensatable", {
          compensate: async () => {
            undos += 1;
            if (undos === 1) throw new Error("warehouse unreachable");
          },
        }),
        step(trace, "two", "compensatable", {
          execute: async () => {
            throw new UnretryableStepError("declined");
          },
        }),
      ]);

      const started = await h.start();
      const first = await h.orchestrator.advance(started.id);
      expect(first?.status).toBe("COMPENSATING");

      const settled = await h.orchestrator.advance(started.id, new Date(Date.now() + 60_000));
      expect(settled?.status).toBe("COMPENSATED");
      expect(undos).toBe(2);
    });

    it("is STUCK, not COMPENSATED, when a compensation runs out of attempts", async () => {
      const trace: Trace = [];
      const h = harness(
        [
          step(trace, "one", "compensatable", {
            compensate: async () => {
              throw new Error("refund endpoint is down");
            },
          }),
          step(trace, "two", "compensatable", {
            execute: async () => {
              throw new UnretryableStepError("declined");
            },
          }),
        ],
        { SAGA_MAX_ATTEMPTS: 1 },
      );

      const settled = await h.orchestrator.advance((await h.start()).id);

      // Reporting COMPENSATED here would be a lie: the system has decided
      // against an operation it has already performed and cannot undo it.
      expect(settled?.status).toBe("STUCK");
      expect(settled?.lastError).toBe("refund endpoint is down");
    });
  });

  describe("past the pivot", () => {
    it("goes STUCK rather than rolling back a step that cannot be rolled back", async () => {
      const trace: Trace = [];
      const h = harness(
        [
          step(trace, "one"),
          step(trace, "ship", "pivot"),
          step(trace, "confirm", "retriable", {
            execute: async () => {
              throw new Error("the database is down");
            },
          }),
        ],
        { SAGA_MAX_ATTEMPTS: 1 },
      );

      const settled = await h.orchestrator.advance((await h.start()).id);

      expect(settled?.status).toBe("STUCK");
      // Nothing was undone. The money is taken and the parcel is booked.
      expect(trace).toEqual(["one", "ship", "confirm"]);
      expect(settled?.lastError).toBe("the database is down");
    });
  });

  describe("leases", () => {
    it("stops quietly when another runner has taken the saga mid-advance", async () => {
      const trace: Trace = [];
      const store = new InMemorySagaStore();
      const registry = new SagaRegistry();
      registry.register(
        defineSaga(SAGA, [
          step(trace, "one", "compensatable", {
            execute: async () => {
              // The lease expires and somebody else claims it while this step
              // is still running — the exact window the fencing token exists
              // for.
              store.expireLease(started.id);
              await store.claim(started.id, {
                owner: "another-runner",
                now: new Date(),
                leaseMs: 60_000,
              });
              return {};
            },
          }),
          step(trace, "two"),
        ]),
      );
      const orchestrator = new SagaOrchestrator(store, registry, stubConfig(CONFIG), () => 0.5);
      const transactions = new InMemoryTransactionRunner();
      const started = await transactions.run((tx) => orchestrator.start(tx, SAGA, {}));

      const settled = await orchestrator.advance(started.id);

      // The step ran, its write was refused, and the second step never started:
      // whatever this runner was about to record is about a step the new owner
      // will re-run.
      expect(trace).toEqual(["one"]);
      expect(settled?.cursor).toBe(0);
      expect(settled?.lockedBy).toBe("another-runner");
    });

    it("holds one claim across a multi-step advance rather than releasing between steps", async () => {
      const trace: Trace = [];
      const h = harness([step(trace, "one"), flaky(trace, "two", 1)]);

      const started = await h.start();
      const settled = await h.orchestrator.advance(started.id);

      // Step one succeeded and step two asked to be retried, so the lease is
      // released — but not between the two.
      expect(trace).toEqual(["one", "two"]);
      expect(settled?.lockedBy).toBeNull();
    });

    it("releases the lease when the saga settles", async () => {
      const trace: Trace = [];
      const h = harness([step(trace, "one")]);

      const settled = await h.orchestrator.advance((await h.start()).id);

      expect(settled?.status).toBe("COMPLETED");
      expect(settled?.lockedBy).toBeNull();
      expect(settled?.lockedUntil).toBeNull();
    });
  });

  describe("sagas it cannot run", () => {
    it("marks an instance STUCK when its definition is not registered", async () => {
      const trace: Trace = [];
      const h = harness([step(trace, "one")]);
      const started = await h.start();

      // A deploy that retired the saga, leaving rows behind. Registering a
      // second registry with nothing in it is how a spec reaches that state.
      const orphaned = new SagaOrchestrator(
        h.store,
        new SagaRegistry(),
        stubConfig(CONFIG),
        () => 0.5,
      );
      const settled = await orphaned.advance(started.id);

      expect(settled?.status).toBe("STUCK");
      expect(settled?.lastError).toMatch(/no definition named "test\.saga" is registered/);
      expect(trace).toEqual([]);
    });

    it("refuses to resume an instance whose steps have been reordered under it", async () => {
      const trace: Trace = [];
      const h = harness([step(trace, "one"), flaky(trace, "two", 1)]);
      const started = await h.start();
      await h.orchestrator.advance(started.id);

      // The redeploy: same saga name, "one" replaced by something else, so the
      // instance's cursor of 1 no longer means what it meant when it was
      // written.
      const registry = new SagaRegistry();
      registry.register(defineSaga(SAGA, [step(trace, "zero"), step(trace, "two")]));
      const redeployed = new SagaOrchestrator(h.store, registry, stubConfig(CONFIG), () => 0.5);

      const settled = await redeployed.advance(started.id, new Date(Date.now() + 60_000));

      expect(settled?.status).toBe("STUCK");
      expect(settled?.lastError).toMatch(/completed "one" at position 0/);
    });

    it("leaves a terminal saga alone", async () => {
      const trace: Trace = [];
      const h = harness([step(trace, "one")]);
      const started = await h.start();
      await h.orchestrator.advance(started.id);

      const again = await h.orchestrator.advance(started.id);

      expect(trace).toEqual(["one"]);
      expect(again?.status).toBe("COMPLETED");
    });

    it("resolves null for an instance that does not exist", async () => {
      const h = harness([step([], "one")]);
      expect(await h.orchestrator.advance("nothing-here")).toBeNull();
    });

    it("refuses to start a saga nobody registered", async () => {
      const h = harness([step([], "one")]);
      const transactions = new InMemoryTransactionRunner();

      await expect(
        transactions.run((tx) => h.orchestrator.start(tx, "order.nothing", {})),
      ).rejects.toThrow(/No saga named "order\.nothing" is registered/);
    });
  });
});
