import { REDIS_TEST_DATABASES } from "./redis-test-databases";

/**
 * The guard that makes the allocation worth centralising.
 *
 * Without it, reusing a number is still only discovered as an intermittent
 * failure in an unrelated suite on whichever CI leg the two workers overlapped
 * on — which is how this cost two debugging sessions. Here it is a deterministic
 * failure in the file that caused it.
 */
describe("REDIS_TEST_DATABASES", () => {
  // Read as plain numbers on purpose. `as const` narrows the values to the
  // literals currently in the file, which makes TypeScript reject the checks
  // below as provably-impossible comparisons — and a guard that only compiles
  // while it is unnecessary is no guard at all. The point is to catch the next
  // edit, not this one.
  const entries: ReadonlyArray<readonly [string, number]> = Object.entries(REDIS_TEST_DATABASES);

  it("gives every suite a database of its own", () => {
    const byDatabase = new Map<number, string[]>();
    for (const [suite, db] of entries) {
      byDatabase.set(db, [...(byDatabase.get(db) ?? []), suite]);
    }

    const shared = [...byDatabase.entries()].filter(([, suites]) => suites.length > 1);

    // Named rather than counted, because the useful thing to report is which
    // two suites would be flushing each other's keys.
    expect(shared.map(([db, suites]) => `db ${db}: ${suites.join(", ")}`)).toEqual([]);
  });

  it("keeps off db 0, which a developer's cache and queue use", () => {
    expect(entries.filter(([, db]) => db === 0)).toEqual([]);
  });

  it("only names databases a default Redis actually serves", () => {
    // `databases 16` is the default, so 0–15. A suite pointed at db 16 fails
    // with `DB index is out of range` on its first command, which is a clearer
    // error than most — but only once someone runs it with a real server.
    expect(entries.filter(([, db]) => !Number.isInteger(db) || db < 0 || db > 15)).toEqual([]);
  });
});
