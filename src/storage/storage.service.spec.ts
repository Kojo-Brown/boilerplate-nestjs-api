import { Test, TestingModule } from "@nestjs/testing";
import { ConfigService } from "@nestjs/config";
import { ServiceUnavailableException } from "@nestjs/common";
import { S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { StorageService } from "./storage.service";

jest.mock("@aws-sdk/client-s3");
jest.mock("@aws-sdk/s3-request-presigner");

const MockS3Client = S3Client as jest.MockedClass<typeof S3Client>;
const mockGetSignedUrl = getSignedUrl as jest.MockedFunction<typeof getSignedUrl>;

const CONFIGURED_ENV: Record<string, string> = {
  S3_BUCKET: "test-bucket",
  S3_ACCESS_KEY_ID: "access-key",
  S3_SECRET_ACCESS_KEY: "secret-key",
  S3_REGION: "us-east-1",
};

async function buildService(env: Record<string, string | undefined> = {}): Promise<StorageService> {
  const mockConfig = { get: jest.fn((key: string) => env[key]) };
  const module: TestingModule = await Test.createTestingModule({
    providers: [StorageService, { provide: ConfigService, useValue: mockConfig }],
  }).compile();
  return module.get(StorageService);
}

describe("StorageService", () => {
  let mockSend: jest.Mock;

  beforeEach(() => {
    jest.resetAllMocks();
    mockSend = jest.fn();
    MockS3Client.mockImplementation(() => ({ send: mockSend }) as unknown as S3Client);
    mockGetSignedUrl.mockResolvedValue("https://presigned.example.com/test-key");
  });

  describe("when S3 is not configured", () => {
    let service: StorageService;

    beforeEach(async () => {
      service = await buildService();
    });

    it("throws ServiceUnavailableException on uploadBuffer", async () => {
      await expect(service.uploadBuffer("key", Buffer.from(""), "image/jpeg")).rejects.toThrow(
        ServiceUnavailableException,
      );
    });

    it("throws ServiceUnavailableException on getPresignedPutUrl", async () => {
      await expect(service.getPresignedPutUrl("key", "image/jpeg")).rejects.toThrow(
        ServiceUnavailableException,
      );
    });

    it("throws ServiceUnavailableException on getPresignedGetUrl", async () => {
      await expect(service.getPresignedGetUrl("key")).rejects.toThrow(ServiceUnavailableException);
    });
  });

  describe("when S3 is configured", () => {
    let service: StorageService;

    beforeEach(async () => {
      service = await buildService(CONFIGURED_ENV);
    });

    it("uploads a buffer and returns the S3 key", async () => {
      mockSend.mockResolvedValue({});
      const key = await service.uploadBuffer("uploads/photo.jpg", Buffer.from("data"), "image/jpeg");
      expect(key).toBe("uploads/photo.jpg");
      expect(mockSend).toHaveBeenCalledTimes(1);
    });

    it("generates a presigned PUT URL with expiry metadata", async () => {
      const result = await service.getPresignedPutUrl("uploads/photo.jpg", "image/jpeg", 3600);
      expect(result.url).toBe("https://presigned.example.com/test-key");
      expect(result.key).toBe("uploads/photo.jpg");
      expect(result.expiresAt).toBeInstanceOf(Date);
    });

    it("generates a presigned GET URL with expiry metadata", async () => {
      const result = await service.getPresignedGetUrl("uploads/photo.jpg", 3600);
      expect(result.url).toBe("https://presigned.example.com/test-key");
      expect(result.key).toBe("uploads/photo.jpg");
      expect(result.expiresAt).toBeInstanceOf(Date);
    });

    it("uses forcePathStyle when S3_ENDPOINT is set (MinIO/LocalStack compatibility)", async () => {
      await buildService({ ...CONFIGURED_ENV, S3_ENDPOINT: "http://localhost:9000" });
      expect(MockS3Client).toHaveBeenCalledWith(
        expect.objectContaining({ forcePathStyle: true, endpoint: "http://localhost:9000" }),
      );
    });

    it("omits forcePathStyle when no custom endpoint is set", async () => {
      await buildService(CONFIGURED_ENV);
      expect(MockS3Client).toHaveBeenCalledWith(
        expect.not.objectContaining({ forcePathStyle: true }),
      );
    });
  });
});
