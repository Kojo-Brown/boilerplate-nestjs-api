import { measureQueryGrowth, recordCalls } from "./n-plus-one";

/** A store with both shapes of read, so a spec can pick the bug or the fix. */
class WidgetStore {
  private readonly rows = new Map<string, { id: string }>();

  seed(count: number): string[] {
    this.rows.clear();
    const ids = Array.from({ length: count }, (_, index) => `widget-${index}`);
    for (const id of ids) this.rows.set(id, { id });
    return ids;
  }

  find(id: string): Promise<{ id: string } | null> {
    return Promise.resolve(this.rows.get(id) ?? null);
  }

  findMany(ids: readonly string[]): Promise<readonly { id: string }[]> {
    return Promise.resolve(ids.flatMap((id) => (this.rows.has(id) ? [{ id }] : [])));
  }
}

describe("recordCalls", () => {
  it("records each method call under the label it was given", async () => {
    const { subject, recorder } = recordCalls(new WidgetStore(), "WidgetStore");
    subject.seed(2);

    await subject.find("widget-0");
    await subject.findMany(["widget-0", "widget-1"]);

    expect(recorder.calls).toEqual([
      "WidgetStore.seed",
      "WidgetStore.find",
      "WidgetStore.findMany",
    ]);
    expect(recorder.count("WidgetStore.find")).toBe(1);
    expect(recorder.count(/find/)).toBe(2);
  });

  it("passes the call through to the real object", async () => {
    const store = new WidgetStore();
    const { subject } = recordCalls(store, "WidgetStore");
    subject.seed(1);

    expect(await subject.find("widget-0")).toEqual({ id: "widget-0" });
    expect(await subject.find("nobody")).toBeNull();
  });

  it("forgets what it recorded when reset", async () => {
    const { subject, recorder } = recordCalls(new WidgetStore(), "WidgetStore");
    subject.seed(1);
    await subject.find("widget-0");

    recorder.reset();

    expect(recorder.calls).toEqual([]);
    expect(recorder.count()).toBe(0);
  });
});

describe("measureQueryGrowth", () => {
  const sizes = [1, 2, 8];

  /**
   * The detector has to fail on a real N+1 — a detector that only ever agrees
   * with the code is worth nothing — so this is the deliberate one.
   */
  it("reports the growth when a read is issued per row", async () => {
    const store = new WidgetStore();
    const { subject, recorder } = recordCalls(store, "WidgetStore");

    const growth = await measureQueryGrowth({
      sizes,
      recorders: [recorder],
      run: async (size) => {
        // Seeded on the real store, so the recorder counts only the reads.
        const ids = store.seed(size);
        await Promise.all(ids.map((id) => subject.find(id)));
      },
    });

    expect(growth.constant).toBe(false);
    expect(growth.countsBySize).toEqual({ 1: 1, 2: 2, 8: 8 });
    expect(growth.callsBySize[8]).toHaveLength(8);
  });

  it("reports a constant count when the rows are read in one batch", async () => {
    const store = new WidgetStore();
    const { subject, recorder } = recordCalls(store, "WidgetStore");

    const growth = await measureQueryGrowth({
      sizes,
      recorders: [recorder],
      run: async (size) => {
        const ids = store.seed(size);
        await subject.findMany(ids);
      },
    });

    expect(growth.constant).toBe(true);
    expect(growth.countsBySize).toEqual({ 1: 1, 2: 1, 8: 1 });
  });

  it("adds up every port the operation touched", async () => {
    const orders = recordCalls(new WidgetStore(), "OrderStore");
    const sagas = recordCalls(new WidgetStore(), "SagaStore");
    orders.subject.seed(1);
    sagas.subject.seed(1);

    const growth = await measureQueryGrowth({
      sizes,
      recorders: [orders.recorder, sagas.recorder],
      run: async () => {
        await orders.subject.findMany(["widget-0"]);
        await sagas.subject.findMany(["widget-0"]);
      },
    });

    expect(growth.countsBySize).toEqual({ 1: 2, 2: 2, 8: 2 });
    expect(growth.callsBySize[1]).toEqual(["OrderStore.findMany", "SagaStore.findMany"]);
  });

  it("refuses a single size, which cannot show growth", async () => {
    const { recorder } = recordCalls(new WidgetStore(), "WidgetStore");

    await expect(
      measureQueryGrowth({ sizes: [4], recorders: [recorder], run: () => Promise.resolve() }),
    ).rejects.toThrow("at least two sizes");
  });
});
