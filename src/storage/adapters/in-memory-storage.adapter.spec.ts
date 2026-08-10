import { InMemoryStorageAdapter } from "./in-memory-storage.adapter";

/**
 * What the shared contract cannot reach: this adapter's role as a test double.
 *
 * The contract proves it behaves like the other two. These tests cover the
 * properties that make it *usable* as a stand-in — an isolated store per
 * instance, a `clear()` that really empties it, and no shared state between
 * suites that would make one test's uploads visible to another's.
 */
describe("InMemoryStorageAdapter", () => {
  let adapter: InMemoryStorageAdapter;

  beforeEach(() => {
    adapter = new InMemoryStorageAdapter();
  });

  it("needs no configuration", () => {
    expect(adapter.isConfigured).toBe(true);
  });

  it("keeps each instance's objects to itself", async () => {
    // Module-level state here would make one suite's uploads visible to
    // another's, which is the classic way an in-memory double stops being a
    // reliable test fixture.
    await adapter.put("shared", Buffer.from("x"), { contentType: "text/plain" });

    expect(await new InMemoryStorageAdapter().exists("shared")).toBe(false);
  });

  it("empties on clear()", async () => {
    await adapter.put("a", Buffer.from("x"), { contentType: "text/plain" });

    adapter.clear();

    expect((await adapter.list()).objects).toEqual([]);
  });

  it("copies the buffer out, so a caller cannot mutate the store through a read", async () => {
    // The contract covers the write side. This is the read side: handing back
    // the stored buffer would let a caller who edited a downloaded file change
    // what the next reader sees — something no real backend does.
    await adapter.put("a", Buffer.from("original"), { contentType: "text/plain" });

    const first = await adapter.get("a");
    first.body.write("MUTATED!");

    expect((await adapter.get("a")).body.toString("utf8")).toBe("original");
  });

  it("rejects rather than throwing synchronously for a missing key", async () => {
    // The methods are `async` specifically so validation and lookup failures
    // arrive as rejections. A synchronous throw would crash a caller that used
    // `.catch()` — and would only do so against this adapter.
    const promise = adapter.get("missing");

    expect(promise).toBeInstanceOf(Promise);
    await expect(promise).rejects.toThrow();
  });

  it("rejects rather than throwing synchronously for an invalid key", async () => {
    const promise = adapter.put("../escape", Buffer.from("x"), { contentType: "text/plain" });

    expect(promise).toBeInstanceOf(Promise);
    await expect(promise).rejects.toThrow();
  });

  it("clamps a page size below 1, so a bad limit cannot mean an empty page forever", async () => {
    for (const key of ["a", "b"]) {
      await adapter.put(key, Buffer.from("x"), { contentType: "text/plain" });
    }

    const page = await adapter.list({ limit: 0 });

    expect(page.objects).toHaveLength(1);
    expect(page.nextCursor).toBe("a");
  });
});
