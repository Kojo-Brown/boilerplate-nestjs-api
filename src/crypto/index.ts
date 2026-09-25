export { CryptoModule } from "./crypto.module";
export { DATA_KEY_CACHE_OPTIONS, FieldEncryptionService } from "./field-encryption.service";
export { encryptedField, fieldName, FIELD_ENCRYPTION_VERSION } from "./encrypted-field";
export {
  EncryptionNotConfiguredError,
  EnvelopeFormatError,
  FieldDecryptionError,
  FieldEncryptionError,
  KeyProviderError,
  DataKeyUnwrapError,
} from "./crypto.errors";
export { KEY_PROVIDER, KEY_PROVIDERS, KEY_PROVIDER_NAMES } from "./ports";
export { KMS_CLIENT_OPTIONS } from "./adapters/aws-kms.key-provider";
export { LocalMasterKeyProvider } from "./adapters/local-master-key.key-provider";
export { AwsKmsKeyProvider } from "./adapters/aws-kms.key-provider";

export type { EncryptedField } from "./encrypted-field";
export type { DataKey, EncryptionContext, KeyProvider, KeyProviderName } from "./ports";
export type { KmsClientOptions } from "./adapters/aws-kms.key-provider";
