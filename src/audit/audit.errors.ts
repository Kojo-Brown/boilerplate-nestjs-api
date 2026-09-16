/**
 * The SQLSTATE the append-only triggers raise.
 *
 * A user-defined code: Postgres reserves class `00` and allows any other
 * five-character code made of digits and upper-case letters. Declared rather
 * than left as plpgsql's default `P0001` so that a caller can recognise *this*
 * refusal — and not every other exception a trigger might raise — without
 * matching on the English in the message.
 *
 * Kept next to the migration that raises it. If one changes, both must.
 */
export const AUDIT_LOG_APPEND_ONLY_SQLSTATE = "AU001";

/**
 * Whether `error` is the database refusing to modify an audit entry.
 *
 * Worth a helper because the code is buried. Prisma 7 reports a driver-adapter
 * failure as `P2039` and puts the real one two levels down, at
 * `meta.driverAdapterError.cause.code` — neither of which is in the client's
 * public types, so reading it means walking `unknown` carefully rather than
 * casting and hoping. `test/audit-log-store.db-spec.ts` pins the shape against
 * a real server, which is the only thing that would notice Prisma moving it.
 *
 * Nothing in this module calls it: the append path never updates or deletes, so
 * a caller seeing this has found a bug or an intrusion either way. It is here
 * for the code that has to tell those apart — a migration, an operator's
 * script, an exception filter — because the alternative is a substring match on
 * a message.
 */
export function isAppendOnlyViolation(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const meta = (error as { meta?: unknown }).meta;
  if (typeof meta !== "object" || meta === null) return false;
  const adapterError = (meta as { driverAdapterError?: unknown }).driverAdapterError;
  if (typeof adapterError !== "object" || adapterError === null) return false;
  const cause = (adapterError as { cause?: unknown }).cause;
  if (typeof cause !== "object" || cause === null) return false;
  return (cause as { code?: unknown }).code === AUDIT_LOG_APPEND_ONLY_SQLSTATE;
}
