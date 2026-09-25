import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from "crypto";
import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { DataKeyUnwrapError, KeyProviderError } from "../crypto.errors";
import { IV_BYTES, TAG_BYTES } from "../field-envelope";
import { DATA_KEY_BYTES } from "../ports";
import type { DataKey, EncryptionContext, KeyProvider } from "../ports";

/** The variable this provider cannot work without. */
export const LOCAL_MASTER_KEY_ENV = "ENCRYPTION_LOCAL_MASTER_KEY";

/** Framing version for a locally wrapped key. Separate from the envelope's. */
const WRAP_VERSION = 1;

/**
 * A master key in an environment variable.
 *
 * It exists so that a clean clone, the test suites and a laptop can encrypt —
 * the same reason `InMemoryStorageAdapter` and the `mock` payment provider
 * exist, and refused in production for the same kind of reason. Be clear about
 * what it is and is not:
 *
 * It **does** give you real AES-256-GCM envelope encryption, byte for byte the
 * same ciphertexts and the same authenticated data as the KMS provider, so
 * everything the format guarantees — a value that cannot be moved between rows,
 * a value that cannot be edited — holds here too. That is what makes it a
 * usable double: the properties the specs assert are properties of the
 * production path.
 *
 * It **does not** give you a key you cannot exfiltrate, a key whose every use
 * is logged, a key an operator can rotate without redeploying, or a key an
 * attacker who has read the process environment does not now have. A master key
 * beside the ciphertext in the same deployment manifest protects against one
 * thing: a stolen database backup. That is not nothing — it is most of what
 * "encryption at rest" is bought for — but it is not the control a compliance
 * regime means by KMS, and `envSchema` refuses this provider in production so
 * nobody discovers the difference during an audit.
 */
@Injectable()
export class LocalMasterKeyProvider implements KeyProvider {
  readonly name = "local" as const;
  readonly requiredEnv = [LOCAL_MASTER_KEY_ENV] as const;

  /**
   * Null when unset or unusable, never a fallback.
   *
   * Generating a random master key when none is configured is the tempting
   * default and the one that must not exist: it works perfectly until the
   * process restarts, at which point every row written before it is
   * unrecoverable — and nothing anywhere logs that this has happened. A missing
   * key is a provider that refuses to work, and `envSchema` turns it into a
   * refused boot before that.
   */
  private readonly masterKey: Buffer | null;

  constructor(config: ConfigService) {
    this.masterKey = decodeMasterKey(config.get<string>(LOCAL_MASTER_KEY_ENV));
  }

  get isConfigured(): boolean {
    return this.masterKey !== null;
  }

  // `async`, so a missing master key arrives as a rejection like every other
  // failure in the port rather than as a synchronous throw from the call site.
  async generateDataKey(context: EncryptionContext): Promise<DataKey> {
    const masterKey = this.requireMasterKey("generateDataKey");
    const plaintext = randomBytes(DATA_KEY_BYTES);

    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv("aes-256-gcm", masterKey, iv, { authTagLength: TAG_BYTES });
    cipher.setAAD(contextAad(context), { plaintextLength: plaintext.length });
    const sealed = Buffer.concat([cipher.update(plaintext), cipher.final()]);

    const wrapped = Buffer.concat([Buffer.from([WRAP_VERSION]), iv, cipher.getAuthTag(), sealed]);
    return await Promise.resolve({ plaintext, wrapped });
  }

  async unwrapDataKey(wrapped: Buffer, context: EncryptionContext): Promise<Buffer> {
    const masterKey = this.requireMasterKey("unwrapDataKey");

    const minimum = 1 + IV_BYTES + TAG_BYTES;
    if (wrapped.length !== minimum + DATA_KEY_BYTES || wrapped.readUInt8(0) !== WRAP_VERSION) {
      throw new DataKeyUnwrapError(
        this.name,
        "this is not a key wrapped by the local provider — wrong length or wrong framing " +
          "version. A deployment that has switched ENCRYPTION_KEY_PROVIDER cannot read what " +
          "the other provider wrote; see docs/field-encryption.md on migrating between them.",
      );
    }

    try {
      const decipher = createDecipheriv(
        "aes-256-gcm",
        masterKey,
        wrapped.subarray(1, 1 + IV_BYTES),
        { authTagLength: TAG_BYTES },
      );
      decipher.setAAD(contextAad(context), { plaintextLength: DATA_KEY_BYTES });
      decipher.setAuthTag(wrapped.subarray(1 + IV_BYTES, minimum));
      return Buffer.concat([decipher.update(wrapped.subarray(minimum)), decipher.final()]);
    } catch (cause: unknown) {
      // The tag did not check out: a different master key, a different
      // encryption context, or an edited blob. One message for all three, for
      // the reason `DataKeyUnwrapError` documents.
      throw new DataKeyUnwrapError(
        this.name,
        "the wrapped data key did not authenticate under this master key and this " +
          "encryption context",
        cause,
      );
    }
  }

  private requireMasterKey(operation: string): Buffer {
    if (this.masterKey === null) {
      throw new KeyProviderError(
        this.name,
        operation,
        `${LOCAL_MASTER_KEY_ENV} is not set to ${DATA_KEY_BYTES} base64-encoded bytes`,
      );
    }
    return this.masterKey;
  }
}

/**
 * The encryption context as authenticated data.
 *
 * KMS authenticates the context itself — a `Decrypt` under a different one is
 * refused by the service — so this provider has to reproduce that or it would be
 * a double that is *weaker* than the thing it stands in for, and a spec proving
 * a wrapped key cannot be moved between columns would pass in production and
 * mean nothing in the suite.
 *
 * Keys are sorted, so two callers building the same context in a different order
 * agree, and each name and value is length-prefixed for the reason
 * `encrypted-field.ts` explains at more length: with a separator alone, a value
 * containing the separator lets one context impersonate another.
 */
export function contextAad(context: EncryptionContext): Buffer {
  const encoded = Object.keys(context)
    .sort()
    .map((key) => {
      const value = context[key] as string;
      return (
        `${Buffer.byteLength(key, "utf8")}:${key}=` +
        `${Buffer.byteLength(value, "utf8")}:${value}\n`
      );
    })
    .join("");

  return Buffer.from(`local-wrap-v${WRAP_VERSION}\n${encoded}`, "utf8");
}

/**
 * Decodes and checks the master key, or returns null for one that cannot be used.
 *
 * Exported because `refineCryptoEnv` performs exactly this check at boot: the
 * refusal an operator reads and the value this class uses have to come from one
 * decoder, or the environment would validate a key the provider then rejects.
 *
 * The round trip through base64 is the check. Node's decoder ignores characters
 * outside the alphabet rather than failing, so `"not a key at all!"` decodes to
 * some bytes and a typo in a secret would be accepted as a *different* key —
 * which encrypts perfectly and cannot read anything written under the intended
 * one. Comparing the re-encoded form against the input is what turns that into a
 * refusal.
 */
export function decodeMasterKey(raw: string | undefined): Buffer | null {
  if (raw === undefined || raw.trim().length === 0) return null;

  const value = raw.trim();
  const decoded = Buffer.from(value, "base64");
  if (decoded.length !== DATA_KEY_BYTES) return null;
  if (decoded.toString("base64").replace(/=+$/, "") !== value.replace(/=+$/, "")) return null;

  // A key of nothing but zero bytes is a valid AES key and is what a
  // placeholder, a truncated secret or an unexpanded template produces. It is
  // refused here rather than silently used, because it is the one key value that
  // is certainly not a secret.
  if (timingSafeEqual(decoded, Buffer.alloc(DATA_KEY_BYTES))) return null;

  return decoded;
}
