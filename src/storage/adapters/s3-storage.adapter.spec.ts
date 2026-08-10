import { HttpStatus } from "@nestjs/common";
import { S3StorageAdapter } from "./s3-storage.adapter";
import {
  ObjectNotFoundError,
  StorageNotConfiguredError,
  StorageOperationError,
} from "../storage.errors";
import { FakeS3Api } from "@/test-utils/fake-s3-api";
import { stubConfig } from "@/test-utils/stub-config";
import type { S3ClientOptions } from "./s3-storage.adapter";

/**
 * What the shared contract cannot reach: the wire itself.
 *
 * The contract proves this adapter behaves like the other two. These tests
 * prove it is actually talking S3 — that metadata reaches the `x-amz-meta-`
 * headers, that `MaxKeys` reaches the query string, that a 404 on HEAD (which
 * carries no XML at all) is still read as a missing object.
 */

const BUCKET = "unit-bucket";

const ENV = {
  S3_BUCKET: BUCKET,
  S3_ACCESS_KEY_ID: "fake-access-key-id",
  S3_SECRET_ACCESS_KEY: "fake-secret-access-key",
  S3_REGION: "eu-west-1",
  S3_ENDPOINT: "http://s3.test",
};

function build(api: FakeS3Api, env: Record<string, string | undefined> = {}): S3StorageAdapter {
  const options: S3ClientOptions = {
    requestHandler: api.requestHandler as unknown as S3ClientOptions["requestHandler"],
    maxAttempts: 1,
  };
  return new S3StorageAdapter(stubConfig({ ...ENV, ...env }), options);
}

describe("S3StorageAdapter", () => {
  let api: FakeS3Api;
  let adapter: S3StorageAdapter;

  beforeEach(() => {
    api = new FakeS3Api(BUCKET);
    adapter = build(api);
  });

  describe("when S3 is not configured", () => {
    it("constructs, reports itself unconfigured, and refuses every call", async () => {
      // Nest instantiates every adapter eagerly, so a deployment running on
      // disk must not blow up merely because S3 credentials are absent.
      const unconfigured = new S3StorageAdapter(stubConfig({}));

      expect(unconfigured.isConfigured).toBe(false);
      await expect(
        unconfigured.put("a", Buffer.from("x"), { contentType: "text/plain" }),
      ).rejects.toThrow(StorageNotConfiguredError);
      await expect(unconfigured.get("a")).rejects.toThrow(StorageNotConfiguredError);
      await expect(unconfigured.head("a")).rejects.toThrow(StorageNotConfiguredError);
      await expect(unconfigured.delete("a")).rejects.toThrow(StorageNotConfiguredError);
      await expect(unconfigured.list()).rejects.toThrow(StorageNotConfiguredError);
      await expect(unconfigured.presignGet("a", 60)).rejects.toThrow(StorageNotConfiguredError);
    });

    it.each([
      ["S3_BUCKET", { S3_BUCKET: undefined }],
      ["S3_ACCESS_KEY_ID", { S3_ACCESS_KEY_ID: undefined }],
      ["S3_SECRET_ACCESS_KEY", { S3_SECRET_ACCESS_KEY: undefined }],
    ])("treats a missing %s as unconfigured", (_name, missing) => {
      // Partial credentials are worse than none: the client would construct and
      // then fail every request with an opaque signature error.
      expect(build(api, missing).isConfigured).toBe(false);
    });

    it("names the variables to set", async () => {
      await expect(new S3StorageAdapter(stubConfig({})).head("a")).rejects.toThrow(
        /Set S3_BUCKET, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY\./,
      );
    });

    it("reports a 503, since the deployment is at fault and not the caller", async () => {
      await expect(new S3StorageAdapter(stubConfig({})).head("a")).rejects.toMatchObject({
        status: HttpStatus.SERVICE_UNAVAILABLE,
      });
    });
  });

  describe("the request it actually sends", () => {
    it("puts user metadata into x-amz-meta- headers", async () => {
      await adapter.put("docs/a.txt", Buffer.from("hello"), {
        contentType: "text/plain",
        metadata: { "uploaded-by": "user-1" },
      });

      // Read back through the fake, which only ever saw the headers — so this
      // passing means the prefix really was applied by the SDK.
      expect((await adapter.head("docs/a.txt")).metadata).toEqual({ "uploaded-by": "user-1" });
    });

    it("sends the cache-control header when one is given", async () => {
      await adapter.put("docs/a.txt", Buffer.from("hello"), {
        contentType: "text/plain",
        cacheControl: "public, max-age=31536000, immutable",
      });

      expect(api.cacheControlOf("docs/a.txt")).toBe("public, max-age=31536000, immutable");
    });

    it("passes the page size through as MaxKeys", async () => {
      for (const key of ["a/1", "a/2", "a/3"]) {
        await adapter.put(key, Buffer.from("x"), { contentType: "text/plain" });
      }
      api.requests.length = 0;

      await adapter.list({ limit: 2, prefix: "a/" });

      expect(api.requests.at(-1)?.query).toMatchObject({ "max-keys": "2", prefix: "a/" });
    });

    it("clamps a page size above S3's own 1000-key ceiling", async () => {
      await adapter.list({ limit: 5000 });

      expect(api.requests.at(-1)?.query["max-keys"]).toBe("1000");
    });

    it("omits the prefix entirely when none is given", async () => {
      // `Prefix: ""` and no prefix are the same to S3, but sending the empty
      // string makes every request diff noisier than it needs to be.
      await adapter.list();

      expect(api.requests.at(-1)?.query).not.toHaveProperty("prefix");
    });
  });

  describe("error translation", () => {
    it("reads a HEAD 404 as a missing object even though it carries no XML", async () => {
      // The one case a code-based check cannot handle: S3 answers HEAD with a
      // bare status and an empty body, so there is no `NoSuchKey` to match on.
      await expect(adapter.head("no/such/key")).rejects.toThrow(ObjectNotFoundError);
    });

    it("reads a GET 404 as a missing object", async () => {
      await expect(adapter.get("no/such/key")).rejects.toThrow(ObjectNotFoundError);
    });

    it("does not read a missing bucket as a missing object", async () => {
      // A 404 either way, and the remedy is completely different: an empty
      // bucket is normal, a bucket that is not there is an operator error and
      // must not look like "no objects yet".
      const wrongBucket = build(api, { S3_BUCKET: "not-the-bucket" });

      const failure = wrongBucket.head("a").catch((error: unknown) => error);

      await expect(failure).resolves.toBeInstanceOf(StorageOperationError);
    });

    it("reports a transport failure as a 502 naming the operation", async () => {
      // A dropped socket rather than an S3 error response: not an
      // `S3ServiceException` at all, so it takes the fallback branch.
      const brokenHandler = {
        handle: () => Promise.reject(new Error("socket hang up")),
        updateHttpClientConfig: () => undefined,
        httpHandlerConfigs: () => ({}),
      };
      const adapterWithFailure = new S3StorageAdapter(stubConfig(ENV), {
        requestHandler: brokenHandler as unknown as S3ClientOptions["requestHandler"],
        maxAttempts: 1,
      });

      const error = await adapterWithFailure.head("a").catch((thrown: unknown) => thrown);

      expect(error).toBeInstanceOf(StorageOperationError);
      expect((error as StorageOperationError).getStatus()).toBe(HttpStatus.BAD_GATEWAY);
      expect((error as StorageOperationError).message).toContain("head a");
      expect((error as StorageOperationError).message).toContain("socket hang up");
    });
  });

  describe("presigned URLs", () => {
    it("signs the content type on uploads, not just the host", async () => {
      const { url } = await adapter.presignPut("docs/a.txt", "image/jpeg", 600);

      expect(url).toContain("X-Amz-SignedHeaders=content-type%3Bhost");
    });

    it("reports the expiry it asked for", async () => {
      const before = Date.now();

      const { expiresAt } = await adapter.presignGet("docs/a.txt", 600);

      expect(expiresAt.getTime()).toBeGreaterThanOrEqual(before + 600_000);
      expect(expiresAt.getTime()).toBeLessThan(before + 601_000);
    });

    it("labels the method so a client cannot use a download URL to upload", async () => {
      expect((await adapter.presignPut("a", "text/plain", 60)).method).toBe("PUT");
      expect((await adapter.presignGet("a", 60)).method).toBe("GET");
    });

    it("validates the key before signing anything", async () => {
      // A signed URL for `../../etc/passwd` is meaningless against S3 but would
      // be a real escape against a store that maps keys to paths.
      await expect(adapter.presignGet("../etc/passwd", 60)).rejects.toThrow(/Invalid storage key/);
    });
  });

  describe("client configuration", () => {
    it("forces path-style addressing when a custom endpoint is set", async () => {
      // MinIO and LocalStack have no wildcard DNS, so virtual-host addressing
      // cannot work against them.
      await adapter.put("docs/a.txt", Buffer.from("x"), { contentType: "text/plain" });

      // The fake parses `/{bucket}/{key}`; it would have seen an empty key
      // under virtual-host addressing.
      expect(api.requests.at(-1)?.key).toBe("docs/a.txt");
    });
  });
});
