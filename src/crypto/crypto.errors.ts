import { ServiceUnavailableException } from "@nestjs/common";
import type { EncryptedField } from "./encrypted-field";
import type { KeyProviderName } from "./ports";

/**
 * Every failure in this module except one is a plain `Error`, not an
 * `HttpException`, and that is the opposite of the choice `storage.errors.ts`
 * made. The reason is what the caller can do about it.
 *
 * A storage failure usually has a remedy a client can act on — send a different
 * key, upload through the API instead. A field that will not decrypt has none:
 * the request was valid, the row is there, and the only honest answer is a 500.
 * `AllExceptionsFilter` renders an unrecognised error as a bare
 * `InternalServerError` with no message, which is also exactly what should
 * leave the process here — the diagnosis belongs in the log, where an operator
 * reads it, and not in a response body where an attacker probing with forged
 * ciphertext reads it too.
 */

/** Anything this module refuses to do. Catch this to catch all of it. */
export class FieldEncryptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/**
 * The stored bytes are not an envelope this build can read.
 *
 * Raised before any key is fetched, because a blob whose framing is wrong is
 * not worth a KMS call. Deliberately says what is structurally wrong — a length
 * that overruns, an unknown format version — and never echoes the bytes.
 */
export class EnvelopeFormatError extends FieldEncryptionError {
  constructor(reason: string) {
    super(`Not a field-encryption envelope: ${reason}`);
  }
}

/**
 * The data key could not be unwrapped, or the ciphertext did not authenticate
 * under it.
 *
 * One error for both, and one message for every cause, because the causes are
 * not distinguishable *to a caller* in any way that helps: a corrupt blob, a
 * ciphertext moved from another row, a wrapped key from another column, a
 * rotated master key that was deleted, and a KMS that is refusing the call all
 * arrive here. Which one it was is in `cause`, and `cause` goes to the log.
 *
 * The field and record are named because the one question an operator always
 * has is "which row?", and answering it from a stack trace alone means
 * correlating a query log. The *value* is never named, for the obvious reason.
 */
export class FieldDecryptionError extends FieldEncryptionError {
  constructor(
    readonly field: EncryptedField,
    readonly recordId: string,
    override readonly cause?: unknown,
  ) {
    super(
      `Could not decrypt ${field.table}.${field.column} of record ${recordId}. Either the ` +
        `stored bytes are not what this key can open — a rotated-away master key, a row ` +
        `restored from a backup taken under another one — or they are not the bytes that were ` +
        `written for this record.`,
    );
  }
}

/** The key manager refused or could not be reached. Carries the underlying failure. */
export class KeyProviderError extends FieldEncryptionError {
  constructor(
    readonly provider: KeyProviderName,
    operation: string,
    message: string,
    override readonly cause?: unknown,
  ) {
    super(`encryption/${provider} ${operation} failed: ${message}`);
  }
}

/** A wrapped key this provider will not accept, or a context that does not match it. */
export class DataKeyUnwrapError extends KeyProviderError {
  constructor(provider: KeyProviderName, message: string, cause?: unknown) {
    super(provider, "unwrap", message, cause);
  }
}

/**
 * The selected provider exists but has nothing to work with.
 *
 * The one `HttpException` here, and a 503 for the reason
 * `StorageNotConfiguredError` is one: the code is fine and the request was
 * fine, the deployment is missing a variable. In practice a request rarely sees
 * it — `KeyProviderFactory` refuses this at boot — but a provider asked for by
 * name after that has to fail with something an operator can act on.
 */
export class EncryptionNotConfiguredError extends ServiceUnavailableException {
  constructor(
    readonly provider: KeyProviderName,
    readonly requiredEnv: readonly string[],
  ) {
    super(
      requiredEnv.length > 0
        ? `Key provider "${provider}" is not configured. Set ${requiredEnv.join(", ")}.`
        : `Key provider "${provider}" is not configured.`,
    );
  }
}
