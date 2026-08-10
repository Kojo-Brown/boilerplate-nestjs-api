import { Test } from "@nestjs/testing";
import { ConfigService } from "@nestjs/config";
import { HttpStatus, Logger } from "@nestjs/common";
import { StorageService } from "./storage.service";
import { STORAGE_ADAPTERS } from "./ports";
import { PresignedUrlsUnsupportedError, StorageNotConfiguredError } from "./storage.errors";
import { InMemoryStorageAdapter } from "./adapters/in-memory-storage.adapter";
import { LocalDiskStorageAdapter } from "./adapters/local-disk-storage.adapter";
import { S3StorageAdapter } from "./adapters/s3-storage.adapter";
import { FakeS3Api } from "@/test-utils/fake-s3-api";
import { stubConfig } from "@/test-utils/stub-config";
import type { S3ClientOptions } from "./adapters/s3-storage.adapter";
import type { StorageAdapter } from "./ports";

const S3_ENV = {
  S3_BUCKET: "test-bucket",
  S3_ACCESS_KEY_ID: "fake-access-key-id",
  S3_SECRET_ACCESS_KEY: "fake-secret-access-key",
  S3_REGION: "us-east-1",
  S3_ENDPOINT: "http://s3.test",
};

function s3Adapter(api = new FakeS3Api("test-bucket")): S3StorageAdapter {
  const options: S3ClientOptions = {
    requestHandler: api.requestHandler as unknown as S3ClientOptions["requestHandler"],
    maxAttempts: 1,
  };
  return new S3StorageAdapter(stubConfig(S3_ENV), options);
}

function build(
  env: Record<string, string | undefined>,
  adapters: readonly StorageAdapter[],
): StorageService {
  return new StorageService(stubConfig(env), adapters);
}

describe("StorageService", () => {
  describe("adapter selection", () => {
    it("selects the adapter named by STORAGE_ADAPTER", () => {
      const service = build({ STORAGE_ADAPTER: "memory" }, [
        s3Adapter(),
        new InMemoryStorageAdapter(),
      ]);

      expect(service.adapterName).toBe("memory");
    });

    it("defaults to the in-memory adapter so a clean clone boots", () => {
      const service = build({}, [new InMemoryStorageAdapter()]);

      expect(service.adapterName).toBe("memory");
    });

    it("refuses to start on an unknown adapter name, listing the real ones", () => {
      // A typo in STORAGE_ADAPTER would otherwise be a 500 on the first upload
      // rather than a failure to boot.
      expect(() => build({ STORAGE_ADAPTER: "s4" }, [new InMemoryStorageAdapter()])).toThrow(
        /not a registered adapter \(memory\)/,
      );
    });

    it("refuses to start when the selected adapter is registered but unconfigured", () => {
      const unconfiguredS3 = new S3StorageAdapter(stubConfig({}));

      expect(() => build({ STORAGE_ADAPTER: "s3" }, [unconfiguredS3])).toThrow(
        StorageNotConfiguredError,
      );
    });

    it("names the missing variables when it refuses", () => {
      const unconfiguredS3 = new S3StorageAdapter(stubConfig({}));

      expect(() => build({ STORAGE_ADAPTER: "s3" }, [unconfiguredS3])).toThrow(
        /S3_BUCKET, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY/,
      );
    });

    it("tolerates other adapters being unconfigured", () => {
      // Running on disk or in memory must not require S3 credentials — that is
      // the whole point of selecting one adapter rather than all of them.
      const service = build({ STORAGE_ADAPTER: "memory" }, [
        new S3StorageAdapter(stubConfig({})),
        new InMemoryStorageAdapter(),
      ]);

      expect(service.adapterName).toBe("memory");
    });

    it("refuses to start when two adapters claim the same name", () => {
      // Which one won would otherwise depend on module registration order.
      expect(() =>
        build({ STORAGE_ADAPTER: "memory" }, [
          new InMemoryStorageAdapter(),
          new InMemoryStorageAdapter(),
        ]),
      ).toThrow(/Duplicate storage adapter/);
    });
  });

  describe("delegation", () => {
    let service: StorageService;
    let adapter: InMemoryStorageAdapter;

    beforeEach(() => {
      adapter = new InMemoryStorageAdapter();
      service = build({ STORAGE_ADAPTER: "memory" }, [adapter]);
    });

    it("stores through the selected adapter", async () => {
      await service.put("docs/a.txt", Buffer.from("hello"), { contentType: "text/plain" });

      expect((await adapter.get("docs/a.txt")).body.toString("utf8")).toBe("hello");
    });

    it("reads back what it stored", async () => {
      await service.put("docs/a.txt", Buffer.from("hello"), { contentType: "text/plain" });

      expect((await service.get("docs/a.txt")).body.toString("utf8")).toBe("hello");
    });

    it("forwards head, exists, delete and list", async () => {
      await service.put("docs/a.txt", Buffer.from("hello"), { contentType: "text/plain" });

      expect((await service.head("docs/a.txt")).size).toBe(5);
      expect(await service.exists("docs/a.txt")).toBe(true);
      expect((await service.list({ prefix: "docs/" })).objects).toHaveLength(1);

      await service.delete("docs/a.txt");

      expect(await service.exists("docs/a.txt")).toBe(false);
    });

    it("streams through the selected adapter", async () => {
      await service.put("docs/a.txt", Buffer.from("hello"), { contentType: "text/plain" });

      const { body } = await service.getStream("docs/a.txt");
      const chunks: Buffer[] = [];
      for await (const chunk of body) chunks.push(Buffer.from(chunk as Buffer));

      expect(Buffer.concat(chunks).toString("utf8")).toBe("hello");
    });

    it("uploadBuffer returns the stored key", async () => {
      // The signature `UsersController` has always called. Kept as a thin call
      // onto `put` so the avatar path cannot drift from the port.
      const key = await service.uploadBuffer("avatars/u1/a.jpg", Buffer.from("x"), "image/jpeg");

      expect(key).toBe("avatars/u1/a.jpg");
      expect(await service.exists("avatars/u1/a.jpg")).toBe(true);
    });
  });

  describe("presigned URLs", () => {
    it("issues them when the adapter can sign", async () => {
      const service = build({ STORAGE_ADAPTER: "s3" }, [s3Adapter()]);

      const result = await service.getPresignedPutUrl("docs/a.txt", "text/plain", 900);

      expect(service.supportsPresignedUrls).toBe(true);
      expect(result.key).toBe("docs/a.txt");
      expect(result.url).toMatch(/^http:\/\/s3\.test\/test-bucket\/docs\/a\.txt\?/);
      expect(result.url).toContain("X-Amz-Signature=");
      expect(result.expiresAt.getTime()).toBeGreaterThan(Date.now());
    });

    it("binds the content type into the upload signature", async () => {
      const service = build({ STORAGE_ADAPTER: "s3" }, [s3Adapter()]);

      const result = await service.getPresignedPutUrl("docs/a.txt", "text/plain", 900);

      // The presigner signs `host` alone unless told otherwise, which would
      // make the content type a suggestion: a client handed a URL for a JPEG
      // could upload an HTML page to the same key and have the bucket serve it
      // from its own origin.
      expect(result.url).toContain("X-Amz-SignedHeaders=content-type%3Bhost");
    });

    it("issues download URLs too", async () => {
      const service = build({ STORAGE_ADAPTER: "s3" }, [s3Adapter()]);

      const result = await service.getPresignedGetUrl("docs/a.txt", 900);

      expect(result.url).toContain("X-Amz-Signature=");
    });

    it("reports 501 — not 503 — when the adapter cannot sign", async () => {
      const service = build({ STORAGE_ADAPTER: "memory" }, [new InMemoryStorageAdapter()]);

      expect(service.supportsPresignedUrls).toBe(false);
      await expect(service.getPresignedPutUrl("a", "text/plain")).rejects.toThrow(
        PresignedUrlsUnsupportedError,
      );
    });

    it("uses 501 so a client does not retry something that can never succeed", async () => {
      const service = build({ STORAGE_ADAPTER: "memory" }, [new InMemoryStorageAdapter()]);

      await expect(service.getPresignedGetUrl("a")).rejects.toMatchObject({
        status: HttpStatus.NOT_IMPLEMENTED,
      });
    });
  });

  describe("production guards", () => {
    let warn: jest.SpyInstance;

    beforeEach(() => {
      warn = jest.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    });

    afterEach(() => {
      warn.mockRestore();
    });

    it("warns when running on the local disk in production", () => {
      // A legitimate single-node setup, and a silent 404 the moment a second
      // replica starts — so it must never be a surprise found during an
      // incident. `env.schema.ts` cannot express this, because it depends on
      // the replica count rather than on the configuration.
      build({ STORAGE_ADAPTER: "local", NODE_ENV: "production" }, [
        new LocalDiskStorageAdapter(stubConfig({ STORAGE_LOCAL_ROOT: "/tmp/unused" })),
      ]);

      expect(warn).toHaveBeenCalledWith(expect.stringContaining("not shared"));
    });

    it("stays quiet on the local disk outside production", () => {
      build({ STORAGE_ADAPTER: "local", NODE_ENV: "development" }, [
        new LocalDiskStorageAdapter(stubConfig({ STORAGE_LOCAL_ROOT: "/tmp/unused" })),
      ]);

      expect(warn).not.toHaveBeenCalled();
    });

    it("stays quiet on S3 in production", () => {
      build({ STORAGE_ADAPTER: "s3", NODE_ENV: "production" }, [s3Adapter()]);

      expect(warn).not.toHaveBeenCalled();
    });
  });

  describe("wired through the Nest injector", () => {
    it("resolves from the STORAGE_ADAPTERS collection", async () => {
      // Proves the token wiring in `storage.module.ts` matches what the service
      // expects, which a hand-constructed service cannot.
      const moduleRef = await Test.createTestingModule({
        providers: [
          StorageService,
          { provide: ConfigService, useValue: stubConfig({ STORAGE_ADAPTER: "memory" }) },
          { provide: STORAGE_ADAPTERS, useValue: [new InMemoryStorageAdapter()] },
        ],
      }).compile();

      expect(moduleRef.get(StorageService).adapterName).toBe("memory");
    });
  });
});
