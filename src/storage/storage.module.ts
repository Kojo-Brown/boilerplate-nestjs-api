import { Module } from "@nestjs/common";
import { StorageService } from "./storage.service";
import { StorageController } from "./storage.controller";
import { InMemoryStorageAdapter } from "./adapters/in-memory-storage.adapter";
import { LocalDiskStorageAdapter } from "./adapters/local-disk-storage.adapter";
import { S3StorageAdapter } from "./adapters/s3-storage.adapter";
import { STORAGE_ADAPTERS } from "./ports";
import type { StorageAdapter } from "./ports";

/**
 * The only file that knows which storage backends exist.
 *
 * Registering a fourth — Azure Blob, GCS, an FTP archive — is two lines, the
 * class in `providers` and the class in `inject`, plus its name in
 * `STORAGE_ADAPTER_NAMES`. Neither `StorageService` nor any consumer changes.
 *
 * All three are instantiated on every boot even though only one is selected.
 * That is what makes the selection a runtime choice rather than a build-time
 * one, and it is safe because none of them touch a network, a disk or a
 * credential at construction — an unconfigured S3 reports
 * `isConfigured === false` and refuses work later.
 *
 * `S3_CLIENT_OPTIONS` is deliberately left unbound: the S3 adapter injects it
 * `@Optional()`, so a deployment that does not need custom client tuning gets
 * the SDK's defaults and the token never has to exist.
 */
@Module({
  controllers: [StorageController],
  providers: [
    S3StorageAdapter,
    LocalDiskStorageAdapter,
    InMemoryStorageAdapter,
    {
      provide: STORAGE_ADAPTERS,
      inject: [S3StorageAdapter, LocalDiskStorageAdapter, InMemoryStorageAdapter],
      useFactory: (...adapters: StorageAdapter[]): readonly StorageAdapter[] => adapters,
    },
    StorageService,
  ],
  // Only the service leaves the module. Exporting the adapters would let a
  // consumer inject S3 directly and undo the indirection this module exists
  // to provide.
  exports: [StorageService],
})
export class StorageModule {}
