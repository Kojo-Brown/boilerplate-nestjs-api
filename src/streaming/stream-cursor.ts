/**
 * The identity a client sends back in `Last-Event-ID` to resume a stream.
 *
 * Two parts, and the first one is the whole reason this is not just a number.
 *
 * `seq` is a position in *this process's* stream of domain events. It is
 * assigned by `EventStreamHub` as events arrive, starts at 0, and means nothing
 * anywhere else: a second replica behind the same load balancer is numbering a
 * different sequence, and a restart of this replica starts numbering again from
 * 0. A bare `seq` would therefore be silently wrong in exactly the situation
 * resume exists for — the client reconnects, lands somewhere else, sends
 * `Last-Event-ID: 41`, and the server confidently replays *its* events 42
 * onward, which are unrelated to the ones the client actually missed.
 *
 * `epoch` is a per-process identity minted at construction, and it turns that
 * silent corruption into a detectable condition: a cursor whose epoch is not
 * the current one cannot be honoured, the server says so in the `stream.open`
 * frame, and the client knows to refetch rather than to believe it is caught
 * up. Being unable to resume is survivable. Believing you resumed when you did
 * not is not.
 *
 * The wire form is `<32 hex>.<digits>`, which is opaque to clients by design —
 * nothing outside this module should parse it, and the format is free to change
 * as long as {@link formatCursor} and {@link parseCursor} change together.
 */
export interface StreamCursor {
  /** 32 lowercase hex characters identifying the process that issued this. */
  readonly epoch: string;
  /** Position within that process's sequence. `0` means "before the first event". */
  readonly seq: number;
}

/**
 * The most digits a `seq` may carry.
 *
 * `Number.MAX_SAFE_INTEGER` is 16 digits, so 15 digits is the widest bound that
 * cannot round on the way through `Number()`. A parser that accepted more would
 * turn a fabricated cursor into a `seq` that compares equal to its neighbours,
 * and the replay window would start in the wrong place rather than being
 * rejected. At any plausible event rate this is not a limit anyone reaches — it
 * is here so the parser has a defined answer rather than an approximate one.
 */
const MAX_SEQ_DIGITS = 15;

const CURSOR_PATTERN = new RegExp(`^([0-9a-f]{32})\\.(0|[1-9][0-9]{0,${MAX_SEQ_DIGITS - 1}})$`);

/** The wire form of a cursor. Always round-trips through {@link parseCursor}. */
export function formatCursor(epoch: string, seq: number): string {
  return `${epoch}.${seq}`;
}

/**
 * Reads a client-supplied cursor, or `null` if it is not one this build issued.
 *
 * Everything here arrives from the network — a `Last-Event-ID` header or a
 * query parameter — so it is validated rather than trusted. `null` is not an
 * error: the caller reports it to the client as a resume it could not honour
 * and streams live from the current position, which is the behaviour the SSE
 * specification asks for and is always safe. What is *not* safe is coercing a
 * malformed value into a number, because `Number("")` and `Number(" ")` are
 * both `0` — a blank header would then request a replay of the entire buffer.
 */
export function parseCursor(raw: string | undefined | null): StreamCursor | null {
  if (typeof raw !== "string") return null;

  const match = CURSOR_PATTERN.exec(raw.trim());
  if (!match) return null;

  return { epoch: match[1]!, seq: Number(match[2]) };
}
