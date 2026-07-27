import { Test, TestingModule } from "@nestjs/testing";
import { CACHE_MANAGER } from "@nestjs/cache-manager";
import { CacheService } from "./cache.service";

const mockCache = {
  get: jest.fn(),
  set: jest.fn(),
  del: jest.fn(),
  mdel: jest.fn(),
  clear: jest.fn(),
};

describe("CacheService", () => {
  let service: CacheService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [CacheService, { provide: CACHE_MANAGER, useValue: mockCache }],
    }).compile();

    service = module.get(CacheService);
    jest.clearAllMocks();
  });

  describe("get", () => {
    it("returns cached value when present", async () => {
      mockCache.get.mockResolvedValue({ id: "1" });
      const result = await service.get<{ id: string }>("user:1");
      expect(result).toEqual({ id: "1" });
      expect(mockCache.get).toHaveBeenCalledWith("user:1");
    });

    it("returns undefined when key is missing", async () => {
      mockCache.get.mockResolvedValue(undefined);
      const result = await service.get("missing");
      expect(result).toBeUndefined();
    });
  });

  describe("set", () => {
    it("stores value with optional TTL", async () => {
      mockCache.set.mockResolvedValue(undefined);
      await service.set("user:1", { id: "1" }, 30_000);
      expect(mockCache.set).toHaveBeenCalledWith("user:1", { id: "1" }, 30_000);
    });

    it("stores value without TTL", async () => {
      mockCache.set.mockResolvedValue(undefined);
      await service.set("user:1", { id: "1" });
      expect(mockCache.set).toHaveBeenCalledWith("user:1", { id: "1" }, undefined);
    });
  });

  describe("del", () => {
    it("deletes a single key", async () => {
      mockCache.del.mockResolvedValue(undefined);
      await service.del("user:1");
      expect(mockCache.del).toHaveBeenCalledWith("user:1");
    });
  });

  describe("delMany", () => {
    it("deletes all provided keys in a single round-trip", async () => {
      mockCache.mdel.mockResolvedValue(true);
      await service.delMany(["user:1", "user:2", "users:list"]);
      expect(mockCache.mdel).toHaveBeenCalledTimes(1);
      expect(mockCache.mdel).toHaveBeenCalledWith(["user:1", "user:2", "users:list"]);
    });

    it("is a no-op for an empty array", async () => {
      await service.delMany([]);
      expect(mockCache.mdel).not.toHaveBeenCalled();
    });
  });

  describe("reset", () => {
    it("clears every configured store", async () => {
      mockCache.clear.mockResolvedValue(true);
      await service.reset();
      expect(mockCache.clear).toHaveBeenCalled();
    });
  });
});
