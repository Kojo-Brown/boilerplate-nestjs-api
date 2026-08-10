import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describeStorageAdapterContract } from "./storage-adapter.contract";
import { InMemoryStorageAdapter } from "./adapters/in-memory-storage.adapter";
import { LocalDiskStorageAdapter } from "./adapters/local-disk-storage.adapter";
import { S3StorageAdapter } from "./adapters/s3-storage.adapter";
import { FakeS3Api } from "@/test-utils/fake-s3-api";
import { stubConfig } from "@/test-utils/stub-config";
import type { S3ClientOptions } from "./adapters/s3-storage.adapter";

/**
 * One contract, three backends.
 *
 * This is the file that makes the adapter pattern mean something: whatever
 * `STORAGE_ADAPTER` is set to, everything downstream behaves the same, and a
 * divergence shows up here rather than in production the first time someone
 * switches. Adding an adapter is one `describeStorageAdapterContract` call.
 */

describeStorageAdapterContract("InMemoryStorageAdapter", () => {
  const adapter = new InMemoryStorageAdapter();
  return { adapter, reset: () => adapter.clear() };
});

/**
 * A real directory under the OS temp root, emptied before each test.
 *
 * Pointing the adapter at a mocked `fs` would leave the interesting parts
 * untested — rename atomicity, `ENOTDIR`, directory nesting — and those are
 * exactly the parts that differ from the other two backends.
 */
const LOCAL_ROOT = join(tmpdir(), `storage-adapter-contract-${process.pid}`);

describeStorageAdapterContract("LocalDiskStorageAdapter", () => {
  const adapter = new LocalDiskStorageAdapter(stubConfig({ STORAGE_LOCAL_ROOT: LOCAL_ROOT }));
  return {
    adapter,
    // The adapter recreates the root on the next write, so removing it outright
    // is both the reset and the proof that `list` copes with a missing root.
    reset: () => rm(LOCAL_ROOT, { recursive: true, force: true }),
  };
});

afterAll(() => rm(LOCAL_ROOT, { recursive: true, force: true }));

describeStorageAdapterContract("S3StorageAdapter", () => {
  // A fresh fake bucket per test, so `reset` has nothing left to do.
  const api = new FakeS3Api("contract-bucket");
  const clientOptions: S3ClientOptions = {
    requestHandler: api.requestHandler as unknown as S3ClientOptions["requestHandler"],
    // The contract exercises 404s deliberately, and the SDK's default retry
    // policy would turn each into three round trips of pointless backoff.
    maxAttempts: 1,
  };

  const adapter = new S3StorageAdapter(
    stubConfig({
      S3_BUCKET: "contract-bucket",
      S3_ACCESS_KEY_ID: "fake-access-key-id",
      S3_SECRET_ACCESS_KEY: "fake-secret-access-key",
      S3_REGION: "us-east-1",
      // Forces path-style addressing, which is what the fake parses.
      S3_ENDPOINT: "http://s3.test",
    }),
    clientOptions,
  );

  return { adapter, reset: () => undefined };
});
