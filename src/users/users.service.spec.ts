import { Test, TestingModule } from "@nestjs/testing";
import { ForbiddenException, NotFoundException } from "@nestjs/common";
import { Role } from "@prisma/client";
import { UsersService } from "./users.service";
import { UsersRepository } from "./users.repository";
import type { User } from "@prisma/client";

const mockUser: User = {
  id: "user-1",
  email: "test@example.com",
  password: "hashed",
  name: "Test User",
  role: Role.USER,
  provider: null,
  providerAccountId: null,
  createdAt: new Date("2024-01-01"),
  updatedAt: new Date("2024-01-01"),
};

const mockRepo = {
  findById: jest.fn(),
  findByEmail: jest.fn(),
  findByProviderAccount: jest.fn(),
  findMany: jest.fn(),
  create: jest.fn(),
  update: jest.fn(),
  delete: jest.fn(),
};

describe("UsersService", () => {
  let service: UsersService;

  beforeEach(async () => {
    jest.resetAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        UsersService,
        { provide: UsersRepository, useValue: mockRepo },
      ],
    }).compile();

    service = module.get<UsersService>(UsersService);
  });

  describe("findById", () => {
    it("returns user when found", async () => {
      mockRepo.findById.mockResolvedValue(mockUser);
      const result = await service.findById("user-1");
      expect(result).toEqual(mockUser);
    });

    it("throws NotFoundException when not found", async () => {
      mockRepo.findById.mockResolvedValue(null);
      await expect(service.findById("missing")).rejects.toThrow(NotFoundException);
    });
  });

  describe("listUsers", () => {
    it("returns a cursor page of users", async () => {
      mockRepo.findMany.mockResolvedValue([mockUser]);
      const result = await service.listUsers({ limit: 20 });
      expect(result.items).toHaveLength(1);
      expect(result.hasNextPage).toBe(false);
      expect(result.nextCursor).toBeNull();
    });

    it("sets hasNextPage and nextCursor when more items exist", async () => {
      const extra: User = { ...mockUser, id: "user-2", email: "b@example.com" };
      mockRepo.findMany.mockResolvedValue([mockUser, extra]);
      const result = await service.listUsers({ limit: 1 });
      expect(result.items).toHaveLength(1);
      expect(result.hasNextPage).toBe(true);
      expect(result.nextCursor).not.toBeNull();
    });
  });

  describe("create", () => {
    it("delegates to repository", async () => {
      mockRepo.create.mockResolvedValue(mockUser);
      const result = await service.create({ email: "test@example.com", password: "hash" });
      expect(result).toEqual(mockUser);
      expect(mockRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({ email: "test@example.com" }),
      );
    });
  });

  describe("update", () => {
    it("calls findById then repo.update", async () => {
      mockRepo.findById.mockResolvedValue(mockUser);
      mockRepo.update.mockResolvedValue({ ...mockUser, name: "Updated" });
      const result = await service.update("user-1", { name: "Updated" });
      expect(result.name).toBe("Updated");
      expect(mockRepo.update).toHaveBeenCalledWith("user-1", { name: "Updated" });
    });

    it("throws NotFoundException for missing user", async () => {
      mockRepo.findById.mockResolvedValue(null);
      await expect(service.update("missing", { name: "X" })).rejects.toThrow(NotFoundException);
    });
  });

  describe("updateSelf", () => {
    it("allows user to update their own profile", async () => {
      mockRepo.findById.mockResolvedValue(mockUser);
      mockRepo.update.mockResolvedValue({ ...mockUser, name: "New Name" });
      const result = await service.updateSelf("user-1", "user-1", { name: "New Name" }, "USER");
      expect(result.name).toBe("New Name");
    });

    it("allows ADMIN to update any profile", async () => {
      mockRepo.findById.mockResolvedValue(mockUser);
      mockRepo.update.mockResolvedValue({ ...mockUser, name: "Changed" });
      const result = await service.updateSelf("admin-1", "user-1", { name: "Changed" }, "ADMIN");
      expect(result.name).toBe("Changed");
    });

    it("throws ForbiddenException when non-admin updates another user", async () => {
      await expect(
        service.updateSelf("user-2", "user-1", { name: "Hack" }, "USER"),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  describe("remove", () => {
    it("deletes the user when found", async () => {
      mockRepo.findById.mockResolvedValue(mockUser);
      mockRepo.delete.mockResolvedValue(mockUser);
      await service.remove("user-1");
      expect(mockRepo.delete).toHaveBeenCalledWith("user-1");
    });

    it("throws NotFoundException for missing user", async () => {
      mockRepo.findById.mockResolvedValue(null);
      await expect(service.remove("missing")).rejects.toThrow(NotFoundException);
    });
  });
});
