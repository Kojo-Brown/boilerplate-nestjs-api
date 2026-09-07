import { InMemorySagaStore } from "@/test-utils/in-memory-saga.store";
import { InMemoryTransactionRunner } from "@/test-utils/in-memory-transaction.runner";
import { stubConfig } from "@/test-utils/stub-config";
import { defineSaga } from "./saga-definition";
import type { SagaStep } from "./saga-definition";
import { SagaOrchestrator } from "./saga-orchestrator.service";
import { SagaRecoveryService } from "./saga-recovery.service";
import { SagaRegistry } from "./saga-registry";
import type { SagaState } from "./saga-state";

const CONFIG = {
  SAGA_RECOVERY_ENABLED: true,
  SAGA_POLL_INTERVAL_MS: 1_000,
  SAGA_RECOVERY_BATCH_SIZE: 2,
  SAGA_LEASE_MS: 60_000,
  SAGA_STEP_TIMEOUT_MS: 5_000,
  SAGA_BACKOFF_BASE_MS: 1_000,
  SAGA_BACKOFF_MAX_MS: 60_000,
  SAGA_MAX_ATTEMPTS: 3,
};

const SAGA = "test.saga";

function step(trace: string[], name: string, fail = false): SagaStep<SagaState> {
  return {
    name,
    kind: "compensatable",
    execute: async () => {
      trace.push(name);
      if (fail) throw new Error(`${name} is unavailable`);
      return {};
    },
    compensate: async () => {
      trace.push(`undo:${name}`);
    },
  };
}

function harness(steps: readonly SagaStep<SagaState>[]) {
  const store = new InMemorySagaStore();
  const registry = new SagaRegistry();
  registry.register(defineSaga(SAGA, steps));
  const orchestrator = new SagaOrchestrator(store, registry, stubConfig(CONFIG), () => 0.5);
  const recovery = new SagaRecoveryService(store, orchestrator, registry, stubConfig(CONFIG));
  const transactions = new InMemoryTransactionRunner();

  return {
    store,
    recovery,
    orchestrator,
    start: () => transactions.run((tx) => orchestrator.start(tx, SAGA, {})),
  };
}

describe("SagaRecoveryService", () => {
  it("claims nothing, and reports so, when nothing is due", async () => {
    const h = harness([step([], "one")]);
    expect(await h.recovery.runOnce()).toEqual({ claimed: 0, advanced: [] });
  });

  it("finishes a saga nobody advanced", async () => {
    // The failure this whole service exists for: the request that placed the
    // order died between the commit and the advance, so the instance is sitting
    // there, due, with nothing driving it.
    const trace: string[] = [];
    const h = harness([step(trace, "one"), step(trace, "two")]);
    const started = await h.start();

    const report = await h.recovery.runOnce();

    expect(report.claimed).toBe(1);
    expect(report.advanced).toEqual([{ id: started.id, status: "COMPLETED" }]);
    expect(trace).toEqual(["one", "two"]);
  });

  it("picks a saga back up once its retry is due, and not before", async () => {
    const trace: string[] = [];
    const h = harness([step(trace, "one", true)]);
    const started = await h.start();
    await h.orchestrator.advance(started.id);
    expect(trace).toEqual(["one"]);

    expect((await h.recovery.runOnce()).claimed).toBe(0);
    expect((await h.recovery.runOnce(new Date(Date.now() + 60_000))).claimed).toBe(1);
    expect(trace).toEqual(["one", "one"]);
  });

  it("honours the batch size, leaving the rest for the next pass", async () => {
    const h = harness([step([], "one")]);
    await h.start();
    await h.start();
    await h.start();

    expect((await h.recovery.runOnce()).claimed).toBe(2);
    expect((await h.recovery.runOnce()).claimed).toBe(1);
  });

  it("carries on with the batch when one saga cannot be advanced at all", async () => {
    const trace: string[] = [];
    const h = harness([step(trace, "one")]);
    const broken = await h.start();
    const healthy = await h.start();

    // A store that fails for exactly one instance stands in for the class of
    // failure the orchestrator does not handle — the machinery itself, rather
    // than a step.
    const save = h.store.save.bind(h.store);
    jest.spyOn(h.store, "save").mockImplementation(async (id, claim, progress) => {
      if (id === broken.id) throw new Error("connection reset");
      return save(id, claim, progress);
    });

    const report = await h.recovery.runOnce();

    expect(report.claimed).toBe(2);
    expect(report.advanced).toEqual(
      expect.arrayContaining([{ id: healthy.id, status: "COMPLETED" }]),
    );
    // The lease expires on its own, so the broken one is simply due again.
    expect((await h.store.find(broken.id))?.status).toBe("RUNNING");
  });

  it("does not start polling when recovery is disabled", async () => {
    const store = new InMemorySagaStore();
    const registry = new SagaRegistry();
    registry.register(defineSaga(SAGA, [step([], "one")]));
    const orchestrator = new SagaOrchestrator(store, registry, stubConfig(CONFIG), () => 0.5);
    const recovery = new SagaRecoveryService(
      store,
      orchestrator,
      registry,
      stubConfig({ ...CONFIG, SAGA_RECOVERY_ENABLED: false }),
    );
    const claimDue = jest.spyOn(store, "claimDue");

    recovery.onApplicationBootstrap();
    await recovery.onModuleDestroy();

    expect(claimDue).not.toHaveBeenCalled();
  });

  it("waits for the pass in flight before it shuts down", async () => {
    const h = harness([step([], "one")]);
    await h.start();

    // `runOnce` is what the timer calls; awaiting the same promise the service
    // holds is what a destroy has to do, or the leases it took stay taken.
    const pass = h.recovery.runOnce();
    await h.recovery.onModuleDestroy();
    await expect(pass).resolves.toEqual(expect.objectContaining({ claimed: 1 }));
  });
});
