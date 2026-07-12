import { Test, TestingModule } from "@nestjs/testing";
import { StorageController } from "./storage.controller";
import { StorageService } from "./storage.service";

const mockPresignedResult = { url: "https://s3.example.com/presigned", key: "test.jpg", expiresAt: new Date() };

const mockStorageService = {
  getPresignedPutUrl: jest.fn(),
  getPresignedGetUrl: jest.fn(),
};

describe("StorageController", () => {
  let controller: StorageController;

  beforeEach(async () => {
    jest.resetAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      controllers: [StorageController],
      providers: [{ provide: StorageService, useValue: mockStorageService }],
    }).compile();

    controller = module.get(StorageController);
  });

  it("should be defined", () => {
    expect(controller).toBeDefined();
  });

  describe("requestPresignedUpload()", () => {
    it("delegates to StorageService.getPresignedPutUrl with key, contentType, expiresIn", async () => {
      mockStorageService.getPresignedPutUrl.mockResolvedValue(mockPresignedResult);
      const dto = { key: "avatars/u1/photo.jpg", contentType: "image/jpeg", expiresIn: 300 };

      const result = await controller.requestPresignedUpload(dto);

      expect(mockStorageService.getPresignedPutUrl).toHaveBeenCalledWith(
        dto.key,
        dto.contentType,
        dto.expiresIn,
      );
      expect(result).toBe(mockPresignedResult);
    });
  });

  describe("requestPresignedDownload()", () => {
    it("delegates to StorageService.getPresignedGetUrl with key and expiresIn", async () => {
      mockStorageService.getPresignedGetUrl.mockResolvedValue(mockPresignedResult);
      const dto = { key: "avatars/u1/photo.jpg", expiresIn: 600 };

      const result = await controller.requestPresignedDownload(dto);

      expect(mockStorageService.getPresignedGetUrl).toHaveBeenCalledWith(dto.key, dto.expiresIn);
      expect(result).toBe(mockPresignedResult);
    });
  });
});
