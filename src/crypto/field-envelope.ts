import { createCipheriv, createDecipheriv, randomBytes } from "crypto";
import { EnvelopeFormatError } from "./crypto.errors";
import { DATA_KEY_BYTES } from "./ports";
import type { DataKey } from "./ports";

/**
 * AES-256-GCM. Not CBC, not CTR, and not "AES" left to a default.
 *
 * GCM is authenticated: the tag is checked before any plaintext is returned, so
 * a ciphertext an attacker edited fails instead of decrypting to something. That
 * is not a nicety for data at rest — the threat model for a database column is
 * precisely an attacker who can *write* it, and an unauthenticated mode lets
 * them flip bits in a stored value and have the application accept the result.
 */
const ALGORITHM = "aes-256-gcm";

/**
 * 96 bits, which is the only IV length GCM is specified for.
 *
 * Longer or shorter is accepted by OpenSSL and silently hashed down through
 * GHASH, which loses the guarantee the standard makes about distinct counters.
 */
export const IV_BYTES = 12;

/** 128 bits: the full tag. Truncating it is a security decision nobody needs. */
export const TAG_BYTES = 16;

/**
 * The on-disk format version, and the first byte of every stored value.
 *
 * It buys the ability to change this format later without guessing: a reader
 * that meets a version it does not know refuses the value by name instead of
 * misparsing it into lengths that happen to fit. It moves together with
 * `FIELD_ENCRYPTION_VERSION`, which is what the authenticated data carries — so
 * a value from a future format cannot be replayed to this one even if the
 * framing were compatible.
 */
export const ENVELOPE_FORMAT_VERSION = 1;

/** Everything before the wrapped key: version, wrapped-key length, IV, tag. */
const HEADER_BYTES = 1 + 2 + IV_BYTES + TAG_BYTES;

/**
 * A stored value, taken apart.
 *
 * The wrapped data key travels *with* the ciphertext rather than in a table of
 * its own, and that is the decision that makes key rotation cheap: re-wrapping
 * a key is a KMS call and a row update, and re-encrypting the data is not needed
 * at all. It costs the wrapped key's bytes — around 180 for a KMS blob — per
 * value, which is the trade a shared key table avoids at the price of a join on
 * every read and a single row every value in the system depends on.
 */
export interface ParsedEnvelope {
  readonly wrappedKey: Buffer;
  readonly iv: Buffer;
  readonly tag: Buffer;
  readonly ciphertext: Buffer;
}

/**
 * Encrypts `plaintext` under `dataKey`, binding `aad` to the result.
 *
 * The IV is random rather than a counter. A counter would be stronger in theory
 * — it cannot repeat — and unimplementable here in practice: every replica would
 * need to share it, and a counter restored from a backup repeats silently, which
 * with GCM is the one failure that leaks the authentication key rather than just
 * a plaintext. 96 random bits with a data key that is retired after
 * `ENCRYPTION_DATA_KEY_MAX_USES` values keeps the collision probability
 * negligible, and that limit is the reason it does: the birthday bound is over
 * the values encrypted under *one* key, not over the lifetime of the service.
 */
export function sealField(dataKey: DataKey, plaintext: Buffer, aad: Buffer): Buffer {
  assertDataKeyLength(dataKey.plaintext);

  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, dataKey.plaintext, iv, {
    authTagLength: TAG_BYTES,
  });
  cipher.setAAD(aad, { plaintextLength: plaintext.length });
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);

  return serialiseEnvelope({
    wrappedKey: dataKey.wrapped,
    iv,
    tag: cipher.getAuthTag(),
    ciphertext,
  });
}

/**
 * Decrypts a parsed envelope under an already-unwrapped data key.
 *
 * Throws whatever `crypto` throws when the tag does not check out. The caller
 * turns that into `FieldDecryptionError`, because at this level there is no way
 * to tell "the wrong key" from "the wrong row" from "an edited byte" — and no
 * reason to: all three mean the same thing, which is that these bytes are not
 * the bytes that were written here.
 */
export function openField(dataKeyPlaintext: Buffer, envelope: ParsedEnvelope, aad: Buffer): Buffer {
  assertDataKeyLength(dataKeyPlaintext);

  const decipher = createDecipheriv(ALGORITHM, dataKeyPlaintext, envelope.iv, {
    authTagLength: TAG_BYTES,
  });
  decipher.setAAD(aad, { plaintextLength: envelope.ciphertext.length });
  decipher.setAuthTag(envelope.tag);
  return Buffer.concat([decipher.update(envelope.ciphertext), decipher.final()]);
}

/** The wire form: `version | wrappedKeyLength | iv | tag | wrappedKey | ciphertext`. */
export function serialiseEnvelope(envelope: ParsedEnvelope): Buffer {
  if (envelope.wrappedKey.length === 0 || envelope.wrappedKey.length > 0xffff) {
    throw new EnvelopeFormatError(
      `a wrapped data key of ${envelope.wrappedKey.length} bytes does not fit the format, ` +
        `which stores the length as a uint16`,
    );
  }

  const header = Buffer.alloc(HEADER_BYTES);
  header.writeUInt8(ENVELOPE_FORMAT_VERSION, 0);
  header.writeUInt16BE(envelope.wrappedKey.length, 1);
  envelope.iv.copy(header, 3);
  envelope.tag.copy(header, 3 + IV_BYTES);

  return Buffer.concat([header, envelope.wrappedKey, envelope.ciphertext]);
}

/**
 * Takes a stored value apart, or refuses it.
 *
 * Every length is checked against the buffer's real length before anything is
 * sliced. `Buffer.subarray` clamps out-of-range indices and returns something
 * shorter rather than throwing, so a truncated value would otherwise arrive at
 * the cipher as a short IV and a short tag — where it would fail, eventually,
 * with a message about neither.
 */
export function parseEnvelope(bytes: Buffer): ParsedEnvelope {
  if (bytes.length < HEADER_BYTES) {
    throw new EnvelopeFormatError(
      `${bytes.length} bytes is shorter than the ${HEADER_BYTES}-byte header`,
    );
  }

  const version = bytes.readUInt8(0);
  if (version !== ENVELOPE_FORMAT_VERSION) {
    throw new EnvelopeFormatError(
      `format version ${version} is not ${ENVELOPE_FORMAT_VERSION}, which is the only one this ` +
        `build can read`,
    );
  }

  const wrappedKeyLength = bytes.readUInt16BE(1);
  if (wrappedKeyLength === 0) {
    throw new EnvelopeFormatError("the wrapped data key is empty");
  }
  if (bytes.length < HEADER_BYTES + wrappedKeyLength) {
    throw new EnvelopeFormatError(
      `the header claims a ${wrappedKeyLength}-byte wrapped data key, which overruns the ` +
        `${bytes.length} bytes stored`,
    );
  }

  return {
    iv: bytes.subarray(3, 3 + IV_BYTES),
    tag: bytes.subarray(3 + IV_BYTES, HEADER_BYTES),
    wrappedKey: bytes.subarray(HEADER_BYTES, HEADER_BYTES + wrappedKeyLength),
    ciphertext: bytes.subarray(HEADER_BYTES + wrappedKeyLength),
  };
}

function assertDataKeyLength(key: Buffer): void {
  if (key.length !== DATA_KEY_BYTES) {
    throw new EnvelopeFormatError(
      `a data key of ${key.length} bytes cannot drive AES-256, which needs ${DATA_KEY_BYTES}`,
    );
  }
}
