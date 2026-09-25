import { Inject, Injectable, Optional } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { cryptoEnvFrom } from "./crypto.env";
import { DataKeyCache } from "./data-key-cache";
import type { DataKeyCacheOptions, DataKeySource } from "./data-key-cache";
import { EnvelopeFormatError, FieldDecryptionError } from "./crypto.errors";
import { fieldKeyContext, recordAad } from "./encrypted-field";
import type { EncryptedField } from "./encrypted-field";
import { openField, parseEnvelope, sealField } from "./field-envelope";
import { KEY_PROVIDER } from "./ports";
import type { DataKey, KeyProvider } from "./ports";

/**
 * Optional DI token for overriding the materials cache's budgets.
 *
 * The same extension point, for the same reason, as `KMS_CLIENT_OPTIONS`: left
 * unbound in `crypto.module.ts`, so production always gets the environment's
 * values and the token never has to exist. It is how a spec shrinks a TTL or a
 * use budget to something it can observe without waiting five minutes for a key
 * to expire.
 */
export const DATA_KEY_CACHE_OPTIONS = Symbol("DATA_KEY_CACHE_OPTIONS");

/**
 * Encrypts and decrypts individual column values.
 *
 * The one thing callers use, and the only place the three parts meet: a
 * {@link KeyProvider} that mints and unwraps data keys, a {@link DataKeyCache}
 * that keeps a KMS round trip off the request path, and the AES-256-GCM envelope
 * format in `field-envelope.ts`.
 *
 * Every method takes the record's id, and that is not a convenience for logging:
 * it is bound into the authenticated data, so a value encrypted for one row
 * cannot be decrypted as another's. A repository is the natural caller precisely
 * because it is the layer that knows the id — see `PrismaOrderStore`.
 *
 * It implements {@link DataKeySource} for the cache rather than handing the
 * cache a provider, which keeps the encryption contexts in one place: the cache
 * knows about columns and budgets and has no opinion about what a key is wrapped
 * under.
 */
@Injectable()
export class FieldEncryptionService implements DataKeySource {
  private readonly cache: DataKeyCache;

  constructor(
    @Inject(KEY_PROVIDER) private readonly provider: KeyProvider,
    config: ConfigService,
    @Optional()
    @Inject(DATA_KEY_CACHE_OPTIONS)
    cacheOptions?: Partial<DataKeyCacheOptions>,
  ) {
    // Through `cryptoEnvFrom` rather than three `config.get(…) ?? default`
    // reads: the defaults belong in one place, next to the documentation of what
    // each budget bounds, and a second copy here is a second copy to disagree
    // with `.env.example`.
    const env = cryptoEnvFrom(config);
    this.cache = new DataKeyCache(this, {
      ttlMs: env.ENCRYPTION_DATA_KEY_TTL_SECONDS * 1000,
      maxUses: env.ENCRYPTION_DATA_KEY_MAX_USES,
      maxDecryptEntries: env.ENCRYPTION_DATA_KEY_CACHE_SIZE,
      ...cacheOptions,
    });
  }

  /** Which provider is in use, for a log line at boot and for the health of it. */
  get providerName(): string {
    return this.provider.name;
  }

  /**
   * Mints this column's data key now rather than during the first write.
   *
   * Called from `onApplicationBootstrap`, where a slow KMS call delays a rollout
   * instead of holding a database transaction open. It resolves even when
   * nothing has been encrypted yet, so it is safe to call on every boot.
   */
  prepare(field: EncryptedField): Promise<void> {
    return this.cache.prepare(field);
  }

  /** The stored form of `plaintext` for `field` on record `recordId`. */
  async encrypt(field: EncryptedField, recordId: string, plaintext: Buffer): Promise<Buffer> {
    const dataKey = await this.cache.encryptionKey(field);
    return sealField(dataKey, plaintext, recordAad(field, recordId));
  }

  /**
   * The plaintext of a stored value.
   *
   * Every way this can fail becomes a {@link FieldDecryptionError} naming the
   * field and the record, with the real cause attached. An `EnvelopeFormatError`
   * is passed through untouched, because it is the one failure that is about the
   * *bytes* rather than about the keys — a value that is not an envelope at all
   * is a build or migration mistake, and saying "could not decrypt" about it
   * would send an operator to look at KMS.
   */
  async decrypt(field: EncryptedField, recordId: string, stored: Buffer): Promise<Buffer> {
    const envelope = parseEnvelope(stored);

    try {
      const dataKey = await this.cache.unwrap(field, envelope.wrappedKey);
      return openField(dataKey, envelope, recordAad(field, recordId));
    } catch (cause: unknown) {
      if (cause instanceof EnvelopeFormatError) throw cause;
      throw new FieldDecryptionError(field, recordId, cause);
    }
  }

  /** {@link encrypt} for a JSON value. */
  encryptJson(field: EncryptedField, recordId: string, value: unknown): Promise<Buffer> {
    return this.encrypt(field, recordId, Buffer.from(JSON.stringify(value), "utf8"));
  }

  /**
   * {@link decrypt} for a JSON value.
   *
   * Returns `unknown`: the bytes authenticated, so they are the bytes this
   * service wrote, but that says nothing about the *shape* a build from six
   * months ago wrote them in. The caller narrows, exactly as it already has to
   * for a `jsonb` column — `PrismaOrderStore` makes the same check on `items`
   * either way.
   *
   * A value that decrypts and then fails to parse is reported as a decryption
   * failure, because from an operator's point of view that is what it is: the
   * column holds something this build cannot read.
   */
  async decryptJson(field: EncryptedField, recordId: string, stored: Buffer): Promise<unknown> {
    const plaintext = await this.decrypt(field, recordId, stored);
    try {
      return JSON.parse(plaintext.toString("utf8")) as unknown;
    } catch (cause: unknown) {
      throw new FieldDecryptionError(field, recordId, cause);
    }
  }

  /** Drops every cached data key. For the specs; see {@link DataKeyCache.clear}. */
  clearKeyCache(): void {
    this.cache.clear();
  }

  /** {@link DataKeySource}: a new data key for this column, from the provider. */
  mint(field: EncryptedField): Promise<DataKey> {
    return this.provider.generateDataKey(fieldKeyContext(field));
  }

  /** {@link DataKeySource}: the plaintext of a wrapped key for this column. */
  unwrap(field: EncryptedField, wrapped: Buffer): Promise<Buffer> {
    return this.provider.unwrapDataKey(wrapped, fieldKeyContext(field));
  }
}
