import { ReplayBuffer } from "./replay-buffer";

interface Entry {
  readonly seq: number;
}

const entry = (seq: number): Entry => ({ seq });

const fill = (buffer: ReplayBuffer<Entry>, from: number, to: number): void => {
  for (let seq = from; seq <= to; seq += 1) buffer.append(entry(seq));
};

describe("ReplayBuffer", () => {
  it.each([0, -1, 1.5, Number.NaN])("refuses a capacity of %p", (capacity) => {
    expect(() => new ReplayBuffer<Entry>(capacity)).toThrow(RangeError);
  });

  it("is empty before anything is appended", () => {
    const buffer = new ReplayBuffer<Entry>(4);

    expect(buffer.size).toBe(0);
    expect(buffer.oldestSeq).toBeNull();
    expect(buffer.since(0)).toEqual([]);
  });

  it("returns every entry strictly after the requested position", () => {
    const buffer = new ReplayBuffer<Entry>(8);
    fill(buffer, 1, 5);

    expect(buffer.since(2)).toEqual([entry(3), entry(4), entry(5)]);
    expect(buffer.since(0)).toEqual([entry(1), entry(2), entry(3), entry(4), entry(5)]);
    expect(buffer.since(5)).toEqual([]);
  });

  it("stops growing at its capacity, dropping the oldest first", () => {
    const buffer = new ReplayBuffer<Entry>(3);
    fill(buffer, 1, 10);

    expect(buffer.size).toBe(3);
    expect(buffer.oldestSeq).toBe(8);
    expect(buffer.since(0)).toEqual([entry(8), entry(9), entry(10)]);
  });

  /**
   * The ring wraps by modular index rather than by shifting an array, so the
   * physical order of the slots stops matching the logical one after the first
   * eviction. Reading straight out of the backing array would start returning
   * the newest entries before the oldest ones from here on.
   */
  it("keeps replay in event order across many wraps", () => {
    const buffer = new ReplayBuffer<Entry>(4);
    fill(buffer, 1, 33);

    expect(buffer.since(0).map((e) => e.seq)).toEqual([30, 31, 32, 33]);
    expect(buffer.since(31).map((e) => e.seq)).toEqual([32, 33]);
  });

  it("reports the oldest retained position, which is what bounds a resume", () => {
    const buffer = new ReplayBuffer<Entry>(2);

    buffer.append(entry(1));
    expect(buffer.oldestSeq).toBe(1);

    buffer.append(entry(2));
    expect(buffer.oldestSeq).toBe(1);

    buffer.append(entry(3));
    expect(buffer.oldestSeq).toBe(2);
  });

  it("serves a capacity of one", () => {
    const buffer = new ReplayBuffer<Entry>(1);
    fill(buffer, 1, 3);

    expect(buffer.size).toBe(1);
    expect(buffer.since(2)).toEqual([entry(3)]);
  });

  /** Positions need not start at 1 — the hub's counter is per process. */
  it("does not assume the sequence starts anywhere in particular", () => {
    const buffer = new ReplayBuffer<Entry>(4);
    fill(buffer, 900, 903);

    expect(buffer.oldestSeq).toBe(900);
    expect(buffer.since(901)).toEqual([entry(902), entry(903)]);
    expect(buffer.since(0)).toHaveLength(4);
  });
});
