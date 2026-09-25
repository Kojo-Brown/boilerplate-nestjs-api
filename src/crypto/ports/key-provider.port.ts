/**
 * The names a deployment may select with `ENCRYPTION_KEY_PROVIDER`.
 *
 * Ordered least to most capable, which is also the order of the argument for
 * having two: `local` exists so a clean clone, a test run and a laptop can
 * encrypt without an AWS account, and `kms` is the only one meant for
 * production. The distinction is not cosmetic — see
 * `LocalMasterKeyProvider` for what a master key in an environment variable
 * does and does not buy you.
 */
export const KEY_PROVIDER_NAMES = ["local", "kms"] as const;

export type KeyProviderName = (typeof KEY_PROVIDER_NAMES)[number];

/** AES-256: the only data-key size this module generates or accepts. */
export const DATA_KEY_BYTES = 32;

/**
 * The name/value pairs bound to a wrapped data key.
 *
 * Not metadata. KMS authenticates the context: a `Decrypt` whose context
 * differs by one byte from the `GenerateDataKey` that produced the blob is
 * refused, and {@link LocalMasterKeyProvider} reproduces that by feeding the
 * context into the wrapping cipher as additional authenticated data. So this is
 * what stops a wrapped key being lifted out of one column and presented as
 * another's — and, because KMS records the context in CloudTrail, it is also
 * what makes a key-use log say *which field* was decrypted rather than merely
 * that something was.
 *
 * Values are strings because that is what the KMS API accepts.
 */
export type EncryptionContext = Readonly<Record<string, string>>;

/** A fresh data key: the bytes to encrypt with, and the form to store. */
export interface DataKey {
  /**
   * {@link DATA_KEY_BYTES} of key material. Lives in this process's memory for
   * as long as the materials cache keeps it and is never written anywhere.
   */
  readonly plaintext: Buffer;
  /**
   * The same key, encrypted under the provider's master key, and the only form
   * that is ever persisted. Opaque to everything but the provider that made it
   * — its length, framing and versioning are that provider's business.
   */
  readonly wrapped: Buffer;
}

/**
 * Where data keys come from.
 *
 * The port is deliberately two methods wide, and neither of them encrypts a
 * field. That split is what envelope encryption *is*: the key manager mints and
 * unwraps keys, the record data is encrypted locally under those keys, and no
 * plaintext row ever crosses the network to the key manager. A port shaped
 * `encrypt(value)` / `decrypt(value)` would look simpler and would send every
 * customer's data to KMS, at a 4 KB limit per call and a network round trip per
 * field.
 *
 * An implementation may be asked for a key it has no credentials for. Both
 * methods therefore reject rather than throw synchronously, and
 * {@link isConfigured} lets the factory refuse a selected-but-unconfigured
 * provider at boot instead of at the first checkout.
 */
export interface KeyProvider {
  readonly name: KeyProviderName;

  /**
   * Whether this provider has everything it needs.
   *
   * Every provider is constructed on every boot — the selection is a runtime
   * choice, exactly as it is for storage adapters — so construction must not
   * throw for a provider this deployment is not using.
   */
  readonly isConfigured: boolean;

  /** The variables an operator must set to make {@link isConfigured} true. */
  readonly requiredEnv: readonly string[];

  /**
   * A new random data key, bound to `context`.
   *
   * The plaintext comes back beside the wrapped form on purpose: that one
   * response is what lets the caller encrypt now and store the wrapped key
   * alongside the ciphertext, with no second call and nothing to reconcile.
   */
  generateDataKey(context: EncryptionContext): Promise<DataKey>;

  /**
   * The plaintext of a key `generateDataKey` wrapped under the *same* context.
   *
   * Rejects with `DataKeyUnwrapError` for a blob this provider did not produce,
   * for a context that does not match, and for a provider that cannot reach its
   * key manager. All three are one rejection by design: telling a caller which
   * of them happened tells an attacker probing with forged blobs the same
   * thing.
   */
  unwrapDataKey(wrapped: Buffer, context: EncryptionContext): Promise<Buffer>;
}

/**
 * DI token for the one provider `ENCRYPTION_KEY_PROVIDER` selected.
 *
 * A symbol for the reason every other token in this codebase is one: two
 * modules cannot collide on it by accident, and an interface is erased at
 * runtime so there is nothing else to inject by.
 */
export const KEY_PROVIDER = Symbol("KEY_PROVIDER");

/** DI token for every provider that was registered, for the factory to choose from. */
export const KEY_PROVIDERS = Symbol("KEY_PROVIDERS");
