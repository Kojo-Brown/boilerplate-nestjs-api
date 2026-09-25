import { Module } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { AwsKmsKeyProvider } from "./adapters/aws-kms.key-provider";
import { LocalMasterKeyProvider } from "./adapters/local-master-key.key-provider";
import { FieldEncryptionService } from "./field-encryption.service";
import { selectKeyProvider } from "./key-provider.factory";
import { KEY_PROVIDER, KEY_PROVIDERS } from "./ports";
import type { KeyProvider, KeyProviderName } from "./ports";

/**
 * The only file that knows which key providers exist.
 *
 * Registering a third — Google Cloud KMS, Vault Transit, an HSM — is the class in
 * `providers`, the class in `inject`, and its name in `KEY_PROVIDER_NAMES`.
 * Neither `FieldEncryptionService` nor any repository changes, which is the
 * property the port exists for.
 *
 * Both are instantiated on every boot even though one is selected, exactly as
 * `StorageModule` does: that is what makes the choice a runtime one, and it is
 * safe because neither touches a network or a credential at construction.
 *
 * `KMS_CLIENT_OPTIONS` is deliberately left unbound. The KMS provider injects it
 * `@Optional()`, so a deployment that needs no client tuning gets the SDK's
 * defaults and the token never has to exist — the same arrangement
 * `storage.module.ts` has with `S3_CLIENT_OPTIONS`.
 *
 * Not `@Global()`. A module that encrypts a column imports this one, and that
 * import is the list of places in the codebase where plaintext meets a key —
 * which is a list worth being able to read off the import graph.
 */
@Module({
  providers: [
    LocalMasterKeyProvider,
    AwsKmsKeyProvider,
    {
      provide: KEY_PROVIDERS,
      inject: [LocalMasterKeyProvider, AwsKmsKeyProvider],
      useFactory: (...providers: KeyProvider[]): readonly KeyProvider[] => providers,
    },
    {
      provide: KEY_PROVIDER,
      inject: [ConfigService, KEY_PROVIDERS],
      useFactory: (config: ConfigService, providers: readonly KeyProvider[]): KeyProvider =>
        selectKeyProvider(
          config.get<KeyProviderName>("ENCRYPTION_KEY_PROVIDER") ?? "local",
          providers,
          config.get<string>("NODE_ENV"),
        ),
    },
    FieldEncryptionService,
  ],
  // Only the service leaves the module. Exporting a provider would let a
  // repository mint its own data keys and bypass the cache, the budgets and the
  // envelope format all at once.
  exports: [FieldEncryptionService],
})
export class CryptoModule {}
