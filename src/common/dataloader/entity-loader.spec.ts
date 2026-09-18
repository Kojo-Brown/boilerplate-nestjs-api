import { createEntityLoader } from "./entity-loader";

interface Widget {
  readonly id: string;
  readonly name: string;
}

/**
 * A batch read that behaves the way a repository does: it answers only for the
 * ids it found, in an order of its own choosing, and it records every batch it
 * was asked for so a spec can count round trips.
 */
function fakeStore(rows: readonly Widget[]) {
  const batches: string[][] = [];
  return {
    batches,
    load: (ids: readonly string[]): Promise<readonly Widget[]> => {
      batches.push([...ids]);
      return Promise.resolve(
        rows.filter((row) => ids.includes(row.id)).sort((a, b) => (a.id < b.id ? 1 : -1)),
      );
    },
  };
}

const WIDGETS: readonly Widget[] = [
  { id: "a", name: "anvil" },
  { id: "b", name: "bellows" },
  { id: "c", name: "crucible" },
];

describe("createEntityLoader", () => {
  it("coalesces every key asked for in one tick into a single read", async () => {
    const store = fakeStore(WIDGETS);
    const loader = createEntityLoader({ load: store.load, identify: (w: Widget) => w.id });

    const loaded = await Promise.all([loader.load("a"), loader.load("b"), loader.load("c")]);

    expect(loaded.map((w) => w?.name)).toEqual(["anvil", "bellows", "crucible"]);
    expect(store.batches).toEqual([["a", "b", "c"]]);
  });

  it("realigns results to keys, whatever order the read returns them in", async () => {
    // The fake sorts descending on purpose. A loader that trusted the position
    // of each row would pair "a" with the crucible and nobody would notice
    // until a customer saw somebody else's order.
    const store = fakeStore(WIDGETS);
    const loader = createEntityLoader({ load: store.load, identify: (w: Widget) => w.id });

    expect(await loader.load("a")).toEqual({ id: "a", name: "anvil" });
    expect(await loader.load("c")).toEqual({ id: "c", name: "crucible" });
  });

  it("resolves null for a key the read found nothing for, and keeps the rest aligned", async () => {
    const store = fakeStore(WIDGETS);
    const loader = createEntityLoader({ load: store.load, identify: (w: Widget) => w.id });

    const loaded = await Promise.all([loader.load("a"), loader.load("missing"), loader.load("b")]);

    // A short array is the failure mode this wrapper exists to prevent:
    // DataLoader matches by position, so one absent row would shift every key
    // after it by one.
    expect(loaded).toEqual([{ id: "a", name: "anvil" }, null, { id: "b", name: "bellows" }]);
  });

  it("asks for a repeated key once", async () => {
    const store = fakeStore(WIDGETS);
    const loader = createEntityLoader({ load: store.load, identify: (w: Widget) => w.id });

    const loaded = await Promise.all([loader.load("a"), loader.load("a"), loader.load("b")]);

    expect(loaded.map((w) => w?.name)).toEqual(["anvil", "anvil", "bellows"]);
    expect(store.batches).toEqual([["a", "b"]]);
  });

  it("serves a key it has already resolved without reading again", async () => {
    const store = fakeStore(WIDGETS);
    const loader = createEntityLoader({ load: store.load, identify: (w: Widget) => w.id });

    await loader.load("a");
    await loader.load("a");

    expect(store.batches).toEqual([["a"]]);
  });

  it("splits a batch larger than maxBatchSize", async () => {
    const store = fakeStore(WIDGETS);
    const loader = createEntityLoader({
      load: store.load,
      identify: (w: Widget) => w.id,
      maxBatchSize: 2,
    });

    const loaded = await Promise.all([loader.load("a"), loader.load("b"), loader.load("c")]);

    expect(loaded.map((w) => w?.name)).toEqual(["anvil", "bellows", "crucible"]);
    expect(store.batches).toEqual([["a", "b"], ["c"]]);
  });

  it("rejects every key in a batch that failed, rather than resolving them null", async () => {
    // The distinction the wrapper is built around: "the read did not work" must
    // not arrive looking like "there is no such row".
    const loader = createEntityLoader<string, Widget>({
      load: () => Promise.reject(new Error("connection terminated")),
      identify: (w) => w.id,
    });

    await expect(Promise.all([loader.load("a"), loader.load("b")])).rejects.toThrow(
      "connection terminated",
    );
  });
});
