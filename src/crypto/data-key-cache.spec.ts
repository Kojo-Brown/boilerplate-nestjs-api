import { randomBytes } from "crypto";
import { DataKeyCache } from "./data-key-cache";
import type { DataKeySource } from "./data-key-cache";
import { encryptedField } from "./encrypted-field";
import type { DataKey } from "./ports";

const FIELD = encryptedField("orders", "itemsCiphertext");
const OTHER_FIELD = encryptedField("users", "phoneCiphertext");

/**
 * A source that counts its calls and can be made to fail or to hang.
 *
 * Counting is the point of most of the specs below: the cache exists to turn N
 * remote calls into one, and "how many times was the key manager asked" is the
 * only assertion that actually says so.
 */
class CountingSource implements DataKeySource {
  mints = 0;
  unwraps = 0;
  failMint: Error | null = null;
  failUnwrap: Error | null = null;
  private pending: Array<() => void> = [];
  /** When true, mints wait for {@link release}. */
  blocking = false;

  private readonly keys = new Map<string, Buffer>();

  async mint(): Promise<DataKey> {
    this.mints += 1;
    if (this.failMint) throw this.failMint;
    if (this.blocking) await new Promise<void>((resolve) => this.pending.push(resolve));

    const plaintext = randomBytes(32);
    const wrapped = randomBytes(16);
    this.keys.set(wrapped.toString("base64"), plaintext);
    return { plaintext, wrapped };
  }

  unwrap(_field: unknown, wrapped: Buffer): Promise<Buffer> {
    this.unwraps += 1;
    if (this.failUnwrap) return Promise.reject(this.failUnwrap);

    const plaintext = this.keys.get(wrapped.toString("base64"));
    return plaintext ? Promise.resolve(plaintext) : Promise.reject(new Error("unknown key"));
  }

  release(): void {
    const waiting = this.pending;
    this.pending = [];
    for (const resolve of waiting) resolve();
  }
}

describe("DataKeyCache", () => {
  let now = 1_000_000;
  let source: CountingSource;

  const cache = (overrides: Partial<ConstructorParameters<typeof DataKeyCache>[1]> = {}) =>
    new DataKeyCache(source, {
      ttlMs: 60_000,
      maxUses: 10,
      maxDecryptEntries: 3,
      now: () => now,
      ...overrides,
    });

  beforeEach(() => {
    now = 1_000_000;
    source = new CountingSource();
  });

  it("mints once and serves the same key to every caller", async () => {
    const keys = cache();

    const first = await keys.encryptionKey(FIELD);
    const second = await keys.encryptionKey(FIELD);

    expect(second.plaintext.equals(first.plaintext)).toBe(true);
    expect(source.mints).toBe(1);
  });

  it("keeps one key per column", async () => {
    const keys = cache();

    const orders = await keys.encryptionKey(FIELD);
    const users = await keys.encryptionKey(OTHER_FIELD);

    expect(users.plaintext.equals(orders.plaintext)).toBe(false);
    expect(source.mints).toBe(2);
  });

  it("makes one call when several callers arrive on a cold cache", async () => {
    // Without in-flight deduplication, a burst at startup is one KMS call per
    // concurrent request — which is exactly when a service is least able to
    // afford them.
    source.blocking = true;
    const keys = cache();

    const inFlight = Promise.all([
      keys.encryptionKey(FIELD),
      keys.encryptionKey(FIELD),
      keys.encryptionKey(FIELD),
    ]);
    source.release();
    const [first, second, third] = await inFlight;

    expect(source.mints).toBe(1);
    expect(second.plaintext.equals(first.plaintext)).toBe(true);
    expect(third.plaintext.equals(first.plaintext)).toBe(true);
  });

  it("replaces the key once its TTL is up", async () => {
    const keys = cache();
    const first = await keys.encryptionKey(FIELD);

    now += 60_001;
    const second = await keys.encryptionKey(FIELD);

    expect(second.plaintext.equals(first.plaintext)).toBe(false);
  });

  it("retires a key after its use budget", async () => {
    // The cryptographic limit rather than the operational one: GCM's random IVs
    // have a birthday bound over the values encrypted under one key.
    const keys = cache({ maxUses: 3, refreshFraction: 0.99 });
    const first = await keys.encryptionKey(FIELD);
    await keys.encryptionKey(FIELD);
    await keys.encryptionKey(FIELD);

    const fourth = await keys.encryptionKey(FIELD);

    expect(fourth.plaintext.equals(first.plaintext)).toBe(false);
  });

  it("replaces the key in the background before it expires, without making a caller wait", async () => {
    // The property that keeps a KMS round trip out of a database transaction: the
    // caller past the refresh threshold is handed the current key and the
    // replacement happens behind it.
    const keys = cache({ refreshFraction: 0.5 });
    const first = await keys.encryptionKey(FIELD);
    expect(source.mints).toBe(1);

    now += 30_001;
    const duringRefresh = await keys.encryptionKey(FIELD);

    expect(duringRefresh.plaintext.equals(first.plaintext)).toBe(true);
    // Settle the background mint before asserting on it.
    await Promise.resolve();
    await Promise.resolve();
    expect(source.mints).toBe(2);

    const afterRefresh = await keys.encryptionKey(FIELD);
    expect(afterRefresh.plaintext.equals(first.plaintext)).toBe(false);
  });

  it("survives a failed background refresh and keeps using the current key", async () => {
    const keys = cache({ refreshFraction: 0.5 });
    const first = await keys.encryptionKey(FIELD);
    source.failMint = new Error("KMS is throttling");

    now += 30_001;
    const served = await keys.encryptionKey(FIELD);
    await Promise.resolve();

    expect(served.plaintext.equals(first.plaintext)).toBe(true);
  });

  it("surfaces the failure once there is no usable key left", async () => {
    const keys = cache();
    await keys.encryptionKey(FIELD);
    source.failMint = new Error("KMS is unreachable");

    now += 60_001;

    await expect(keys.encryptionKey(FIELD)).rejects.toThrow("KMS is unreachable");
  });

  it("unwraps a wrapped key once per TTL, however many rows carry it", async () => {
    // The read-side half: every row on a page written in the same window carries
    // the same wrapped key, so this is what makes reading a page one call.
    const keys = cache();
    const key = await keys.encryptionKey(FIELD);

    const unwrapped = await Promise.all([
      keys.unwrap(FIELD, key.wrapped),
      keys.unwrap(FIELD, key.wrapped),
      keys.unwrap(FIELD, key.wrapped),
    ]);

    expect(source.unwraps).toBe(1);
    expect(unwrapped.every((plaintext) => plaintext.equals(key.plaintext))).toBe(true);
  });

  it("does not remember a failed unwrap", async () => {
    // A throttled call has to be retryable. Caching the rejection would turn a
    // momentary KMS failure into a column that cannot be read for a whole TTL.
    const keys = cache();
    const key = await keys.encryptionKey(FIELD);
    source.failUnwrap = new Error("KMS is throttling");

    await expect(keys.unwrap(FIELD, key.wrapped)).rejects.toThrow("throttling");
    source.failUnwrap = null;

    expect((await keys.unwrap(FIELD, key.wrapped)).equals(key.plaintext)).toBe(true);
    expect(source.unwraps).toBe(2);
  });

  it("re-unwraps once the cached plaintext has expired", async () => {
    // What bounds how long this process can still read rows after its grant is
    // revoked.
    const keys = cache();
    const key = await keys.encryptionKey(FIELD);
    await keys.unwrap(FIELD, key.wrapped);

    now += 60_001;
    await keys.unwrap(FIELD, key.wrapped);

    expect(source.unwraps).toBe(2);
  });

  it("does not confuse one column's wrapped key with another's", async () => {
    const keys = cache();
    const key = await keys.encryptionKey(FIELD);
    await keys.unwrap(FIELD, key.wrapped);

    await keys.unwrap(OTHER_FIELD, key.wrapped);

    // Same bytes, different column: a separate cache entry, because the
    // encryption context differs and so may the answer.
    expect(source.unwraps).toBe(2);
  });

  it("bounds the unwrap cache", async () => {
    const keys = cache({ maxDecryptEntries: 2 });
    const first = await keys.encryptionKey(FIELD);
    now += 60_001;
    const second = await keys.encryptionKey(FIELD);
    now += 60_001;
    const third = await keys.encryptionKey(FIELD);

    await keys.unwrap(FIELD, first.wrapped);
    await keys.unwrap(FIELD, second.wrapped);
    await keys.unwrap(FIELD, third.wrapped);

    expect(keys.sizes.unwrapped).toBe(2);
    // The oldest insertion went, so reading it again is a fresh call.
    await keys.unwrap(FIELD, first.wrapped);
    expect(source.unwraps).toBe(4);
  });

  it("warms a column's key without encrypting anything", async () => {
    const keys = cache();

    await keys.prepare(FIELD);

    expect(source.mints).toBe(1);
    await keys.encryptionKey(FIELD);
    expect(source.mints).toBe(1);
  });

  it("forgets everything on clear", async () => {
    const keys = cache();
    const key = await keys.encryptionKey(FIELD);
    await keys.unwrap(FIELD, key.wrapped);

    keys.clear();

    expect(keys.sizes).toEqual({ active: 0, unwrapped: 0 });
  });

  it.each([
    ["a zero TTL", { ttlMs: 0 }],
    ["a zero use budget", { maxUses: 0 }],
    ["a zero cache size", { maxDecryptEntries: 0 }],
    ["a refresh fraction of 0", { refreshFraction: 0 }],
    ["a refresh fraction of 1", { refreshFraction: 1 }],
  ])("refuses %s", (_case, overrides) => {
    expect(() => cache(overrides)).toThrow();
  });
});
