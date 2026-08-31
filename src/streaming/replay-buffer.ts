/**
 * The bounded window of recent events a reconnecting client can be caught up
 * from.
 *
 * Resume needs somewhere to read the missed events from, and the choice of
 * where is the main design decision in this module. This is a fixed-size ring
 * in the process's memory, which buys three things — no I/O on the reconnect
 * path, no schema, and no coupling to the outbox's delivery state — at the cost
 * of the two limits written up in `docs/streaming.md`: the window is bounded by
 * event count rather than by time, and it does not survive a restart or reach
 * another replica. Both are *detectable* rather than silent, which is what
 * makes them acceptable: the epoch in {@link import("./stream-cursor").StreamCursor}
 * catches the second and {@link ReplayBuffer.oldestSeq} catches the first, and a
 * client that cannot be resumed is told so.
 *
 * Bounded by construction, not by a sweeper: an unbounded buffer is a memory
 * leak with a slow fuse, since nothing ever removes an event that every
 * connected client has already seen — there is no such thing as "every client"
 * when the next one may connect tomorrow asking for history.
 */
export class ReplayBuffer<T extends { readonly seq: number }> {
  private readonly slots: (T | undefined)[];

  /** Total appends over the buffer's lifetime, not the number retained. */
  private appended = 0;

  constructor(readonly capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new RangeError(`ReplayBuffer capacity must be a positive integer, got ${capacity}`);
    }
    this.slots = new Array<T | undefined>(capacity);
  }

  /**
   * Records one event, evicting the oldest once the buffer is full.
   *
   * Entries must arrive in strictly increasing `seq` order — {@link since}
   * relies on it to stop scanning. `EventStreamHub` is the only caller and
   * assigns `seq` itself, so this is an invariant of the module rather than
   * something a user of the API could get wrong.
   */
  append(entry: T): void {
    this.slots[this.appended % this.capacity] = entry;
    this.appended += 1;
  }

  /** How many entries are retained right now. */
  get size(): number {
    return Math.min(this.appended, this.capacity);
  }

  /**
   * The `seq` of the oldest retained entry, or `null` while empty.
   *
   * This is what decides whether a resume is possible: a cursor at or after
   * this position can be served in full, one before it has fallen out of the
   * window and the client has to be told it lost events.
   */
  get oldestSeq(): number | null {
    const oldest = this.slots[this.oldestIndex() % this.capacity];
    return oldest?.seq ?? null;
  }

  /**
   * Every retained entry strictly after `seq`, oldest first.
   *
   * Linear in the number of retained entries rather than binary — the buffer is
   * bounded (a few thousand at most), and this runs once per connection, not
   * per event. The scan stops early because entries are ordered.
   */
  since(seq: number): readonly T[] {
    const out: T[] = [];
    const end = this.appended;

    for (let i = this.oldestIndex(); i < end; i += 1) {
      const entry = this.slots[i % this.capacity];
      if (entry && entry.seq > seq) out.push(entry);
    }

    return out;
  }

  private oldestIndex(): number {
    return Math.max(0, this.appended - this.capacity);
  }
}
