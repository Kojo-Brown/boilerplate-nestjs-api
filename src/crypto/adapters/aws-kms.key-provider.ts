import { Inject, Injectable, Optional } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  DecryptCommand,
  GenerateDataKeyCommand,
  IncorrectKeyException,
  InvalidCiphertextException,
  KMSClient,
  KMSServiceException,
  NotFoundException as KmsNotFoundException,
} from "@aws-sdk/client-kms";
import type { KMSClientConfig } from "@aws-sdk/client-kms";
import { DataKeyUnwrapError, KeyProviderError } from "../crypto.errors";
import { DATA_KEY_BYTES } from "../ports";
import type { DataKey, EncryptionContext, KeyProvider } from "../ports";

/** The variable this provider cannot work without. */
export const KMS_KEY_ID_ENV = "ENCRYPTION_KMS_KEY_ID";

/**
 * Optional DI token for extra `KMSClient` configuration.
 *
 * The same extension point, for the same two reasons, as
 * `STORAGE_CLIENT_OPTIONS` in `s3-storage.adapter.ts`: an operator tunes retries
 * and timeouts on the client rather than through the environment, and a
 * `RequestHandler` cannot be expressed as a string.
 *
 * It is also how `key-provider.contract.spec.ts` reaches this class. The
 * contract installs an in-process `requestHandler`, so a command really is
 * signed, serialised into KMS's JSON protocol and answered with a response the
 * SDK's own parser has to make sense of. Stubbing `KMSClient.send` would be a
 * fifth of the code and would test this adapter against our idea of the SDK: a
 * blob we forgot to base64-encode, an `EncryptionContext` that never reached the
 * request body, a `KeyId` we left off the `Decrypt` — a stub is handed the
 * parsed command and sees none of it.
 */
export const KMS_CLIENT_OPTIONS = Symbol("KMS_CLIENT_OPTIONS");

/** The subset of `KMSClientConfig` this adapter lets a caller override. */
export interface KmsClientOptions {
  readonly requestHandler?: KMSClientConfig["requestHandler"];
  readonly maxAttempts?: number;
  readonly endpoint?: KMSClientConfig["endpoint"];
  readonly credentials?: KMSClientConfig["credentials"];
}

/**
 * AWS KMS, and anything that speaks its API — LocalStack, or a KMS-compatible
 * HSM front end.
 *
 * The only provider meant for production, and what makes the arrangement in this
 * module envelope encryption rather than "encryption with an extra step": the
 * master key never leaves KMS, this process only ever holds data keys, and every
 * data key it holds was minted or unwrapped by a call that CloudTrail recorded
 * with the column it was for.
 *
 * Credentials are deliberately **not** read from the environment. The whole
 * point of keeping the master key in KMS is that possessing the environment is
 * not enough, and a deployment that pastes an access key beside the key id has
 * given that up. So the SDK's default chain resolves them, which on EKS is IRSA
 * and on EC2 is the instance role — a credential this process cannot print
 * because it never sees it for longer than an hour. A test or a LocalStack run
 * passes them through {@link KMS_CLIENT_OPTIONS} instead.
 *
 * Construction never throws and never touches the network: every provider is
 * built on every boot so the selection stays a runtime choice.
 */
@Injectable()
export class AwsKmsKeyProvider implements KeyProvider {
  readonly name = "kms" as const;
  readonly requiredEnv = [KMS_KEY_ID_ENV] as const;

  private readonly keyId: string | null;
  private readonly client: KMSClient;

  constructor(
    config: ConfigService,
    @Optional() @Inject(KMS_CLIENT_OPTIONS) options?: KmsClientOptions,
  ) {
    const keyId = config.get<string>(KMS_KEY_ID_ENV)?.trim();
    this.keyId = keyId && keyId.length > 0 ? keyId : null;

    this.client = new KMSClient({
      // An explicit region wins; otherwise the key's own ARN names one, and
      // reading it from there is what lets a deployment configure this provider
      // with a single variable. Falling through to `undefined` leaves the SDK's
      // own resolution (AWS_REGION, then the instance's metadata) in place
      // rather than inventing a default that would send every call to the wrong
      // account's KMS.
      region:
        config.get<string>("ENCRYPTION_KMS_REGION")?.trim() ||
        regionFromKeyArn(this.keyId) ||
        undefined,
      ...options,
    });
  }

  get isConfigured(): boolean {
    return this.keyId !== null;
  }

  async generateDataKey(context: EncryptionContext): Promise<DataKey> {
    const keyId = this.requireKeyId("generateDataKey");

    try {
      const response = await this.client.send(
        new GenerateDataKeyCommand({
          KeyId: keyId,
          // `KeySpec` rather than `NumberOfBytes`: both produce 32 bytes, and
          // only this one says in the API call — and therefore in CloudTrail —
          // what the key is for.
          KeySpec: "AES_256",
          EncryptionContext: { ...context },
        }),
      );

      const plaintext = response.Plaintext;
      const wrapped = response.CiphertextBlob;
      if (!plaintext || !wrapped) {
        throw new Error("KMS returned no key material");
      }
      if (plaintext.length !== DATA_KEY_BYTES) {
        // KMS cannot do this, and checking costs nothing. A short key would
        // otherwise be caught by `createCipheriv` several frames away, with a
        // message about AES rather than about KMS.
        throw new Error(
          `KMS returned ${plaintext.length} bytes of key material, not ${DATA_KEY_BYTES}`,
        );
      }

      return { plaintext: Buffer.from(plaintext), wrapped: Buffer.from(wrapped) };
    } catch (cause: unknown) {
      throw this.asProviderError("generateDataKey", cause);
    }
  }

  async unwrapDataKey(wrapped: Buffer, context: EncryptionContext): Promise<Buffer> {
    const keyId = this.requireKeyId("unwrapDataKey");

    try {
      const response = await this.client.send(
        new DecryptCommand({
          CiphertextBlob: wrapped,
          EncryptionContext: { ...context },
          /**
           * Pinned, and this is the line that matters most in the file.
           *
           * `Decrypt` does not need a `KeyId` — the blob names the key that
           * wrapped it, and KMS will use it if this role is allowed to. That is
           * exactly the problem. An attacker who can write this column, and who
           * has any key in an account this role can decrypt under, can replace
           * a wrapped data key with one they minted, and then supply a
           * ciphertext that authenticates under *their* data key. The
           * per-record additional authenticated data does not help: they can
           * compute it, because it is derived from the table, the column and
           * the row id. Naming the key here means a blob from any other key is
           * refused before it is used.
           */
          KeyId: keyId,
        }),
      );

      const plaintext = response.Plaintext;
      if (!plaintext || plaintext.length !== DATA_KEY_BYTES) {
        throw new Error(`KMS returned ${plaintext?.length ?? 0} bytes, not ${DATA_KEY_BYTES}`);
      }
      return Buffer.from(plaintext);
    } catch (cause: unknown) {
      throw this.asProviderError("unwrapDataKey", cause);
    }
  }

  private requireKeyId(operation: string): string {
    if (this.keyId === null) {
      throw new KeyProviderError(
        this.name,
        operation,
        `${KMS_KEY_ID_ENV} is not set. It takes a key id, an alias (alias/orders-field-key) or ` +
          `a full ARN.`,
      );
    }
    return this.keyId;
  }

  /**
   * Sorts a KMS failure into "these bytes are not ours" and everything else.
   *
   * The distinction is the one the materials cache depends on: a wrapped key
   * that will never unwrap must not be retried, while a throttle or a timeout
   * must. `InvalidCiphertextException` is the one KMS raises both for a corrupt
   * blob *and* for an encryption context that does not match, which is why they
   * arrive at the caller as one error — see `DataKeyUnwrapError`.
   */
  private asProviderError(operation: string, cause: unknown): Error {
    if (cause instanceof DataKeyUnwrapError || cause instanceof KeyProviderError) return cause;

    if (cause instanceof InvalidCiphertextException || cause instanceof IncorrectKeyException) {
      return new DataKeyUnwrapError(
        this.name,
        "KMS refused the wrapped data key: it is not a blob this key produced under this " +
          "encryption context",
        cause,
      );
    }

    if (cause instanceof KmsNotFoundException) {
      return new KeyProviderError(
        this.name,
        operation,
        `KMS does not have the key named by ${KMS_KEY_ID_ENV}. If this row was written before a ` +
          `key rotation that deleted the old key, its data key cannot be unwrapped by anything.`,
        cause,
      );
    }

    if (cause instanceof KMSServiceException) {
      return new KeyProviderError(this.name, operation, `${cause.name}: ${cause.message}`, cause);
    }

    return new KeyProviderError(
      this.name,
      operation,
      cause instanceof Error ? cause.message : String(cause),
      cause,
    );
  }
}

/**
 * The region out of a key ARN, or null for a bare id or an alias.
 *
 * `arn:aws:kms:eu-west-2:111122223333:key/1234abcd-…` — the fourth field. A
 * region read from the ARN is the region the key is really in, which beats
 * whatever `AWS_REGION` happens to say in a process that talks to more than one.
 */
export function regionFromKeyArn(keyId: string | null): string | null {
  if (keyId === null || !keyId.startsWith("arn:")) return null;
  const region = keyId.split(":")[3];
  return region && region.length > 0 ? region : null;
}
