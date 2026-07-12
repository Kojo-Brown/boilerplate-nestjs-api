import { Test, TestingModule } from "@nestjs/testing";
import { BadRequestException, ForbiddenException } from "@nestjs/common";
import { UsersController } from "./users.controller";
import { UsersService } from "./users.service";
import { StorageService } from "@/storage/storage.service";
import type { AuthenticatedUser } from "@/auth/strategies/jwt.strategy";
import { Role } from "@prisma/client";
import type { User } from "@prisma/client";

const mockUser: User = {
  id: "user-1",
  email: "test@example.com",
  password: "hashed",
  name: "Test User",
  role: Role.USER,
  provider: null,
  providerAccountId: null,
  avatarUrl: null,
  preferences: null,
  createdAt: new Date("2024-01-01"),
  updatedAt: new Date("2024-01-01"),
};

const requester: AuthenticatedUser = { id: "user-1", email: "test@example.com", role: "USER" };

const mockUsersService = {
  listUsers: jest.fn(),
  findById: jest.fn(),
  updateSelf: jest.fn(),
  updateAvatar: jest.fn(),
  remove: jest.fn(),
  getPreferences: jest.fn(),
  updatePreferences: jest.fn(),
};

const mockStorageService = {
  uploadBuffer: jest.fn(),
};

describe("UsersController", () => {
  let controller: UsersController;

  beforeEach(async () => {
    jest.resetAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      controllers: [UsersController],
      providers: [
        { provide: UsersService, useValue: mockUsersService },
        { provide: StorageService, useValue: mockStorageService },
      ],
    }).compile();

    controller = module.get(UsersController);
  });

  it("should be defined", () => {
    expect(controller).toBeDefined();
  });

  describe("listUsers()", () => {
    it("delegates to UsersService.listUsers", async () => {
      const page = { data: [mockUser], nextCursor: null };
      mockUsersService.listUsers.mockResolvedValue(page);
      const query = { limit: 20 };

      const result = await controller.listUsers(query as never);

      expect(mockUsersService.listUsers).toHaveBeenCalledWith(query);
      expect(result).toBe(page);
    });
  });

  describe("findOne()", () => {
    it("delegates to UsersService.findById", async () => {
      mockUsersService.findById.mockResolvedValue(mockUser);

      const result = await controller.findOne("user-1");

      expect(mockUsersService.findById).toHaveBeenCalledWith("user-1");
      expect(result).toBe(mockUser);
    });
  });

  describe("update()", () => {
    it("delegates to UsersService.updateSelf with requester info", async () => {
      const updated = { ...mockUser, name: "New Name" };
      mockUsersService.updateSelf.mockResolvedValue(updated);
      const dto = { name: "New Name" };

      const result = await controller.update("user-1", dto, requester);

      expect(mockUsersService.updateSelf).toHaveBeenCalledWith("user-1", "user-1", dto, "USER");
      expect(result).toBe(updated);
    });
  });

  describe("uploadAvatar()", () => {
    const file: Express.Multer.File = {
      originalname: "photo.jpg",
      buffer: Buffer.from("img"),
      mimetype: "image/jpeg",
      fieldname: "file",
      encoding: "7bit",
      size: 3,
      stream: null as never,
      destination: "",
      filename: "",
      path: "",
    };

    it("uploads to storage and calls updateAvatar", async () => {
      mockStorageService.uploadBuffer.mockResolvedValue(undefined);
      mockUsersService.updateAvatar.mockResolvedValue({ ...mockUser, avatarUrl: "avatars/user-1/photo.jpg" });

      const result = await controller.uploadAvatar("user-1", file, requester);

      expect(mockStorageService.uploadBuffer).toHaveBeenCalledWith(
        expect.stringContaining("avatars/user-1/"),
        file.buffer,
        "image/jpeg",
      );
      expect(mockUsersService.updateAvatar).toHaveBeenCalled();
      expect(result).toMatchObject({ avatarUrl: expect.stringContaining("avatars/user-1/") });
    });

    it("throws BadRequestException when no file is provided", async () => {
      await expect(controller.uploadAvatar("user-1", undefined, requester)).rejects.toThrow(
        BadRequestException,
      );
    });

    it("throws ForbiddenException when a non-admin user uploads for another user", async () => {
      const otherRequester: AuthenticatedUser = { id: "other-user", email: "other@example.com", role: "USER" };

      await expect(controller.uploadAvatar("user-1", file, otherRequester)).rejects.toThrow(
        ForbiddenException,
      );
    });

    it("allows an ADMIN to upload avatar for another user", async () => {
      const adminRequester: AuthenticatedUser = { id: "admin-1", email: "admin@example.com", role: "ADMIN" };
      mockStorageService.uploadBuffer.mockResolvedValue(undefined);
      mockUsersService.updateAvatar.mockResolvedValue({ ...mockUser, avatarUrl: "avatars/user-1/x.jpg" });

      await expect(
        controller.uploadAvatar("user-1", file, adminRequester),
      ).resolves.toBeDefined();
    });
  });

  describe("remove()", () => {
    it("delegates to UsersService.remove", async () => {
      mockUsersService.remove.mockResolvedValue(undefined);

      await controller.remove("user-1");

      expect(mockUsersService.remove).toHaveBeenCalledWith("user-1");
    });
  });

  describe("getPreferences()", () => {
    it("delegates to UsersService.getPreferences with requester info", async () => {
      const prefs = { theme: "dark", language: "en", emailNotifications: true, pushNotifications: false, timezone: "UTC" };
      mockUsersService.getPreferences.mockResolvedValue(prefs);

      const result = await controller.getPreferences("user-1", requester);

      expect(mockUsersService.getPreferences).toHaveBeenCalledWith("user-1", "user-1", "USER");
      expect(result).toBe(prefs);
    });
  });

  describe("updatePreferences()", () => {
    it("delegates to UsersService.updatePreferences with requester info", async () => {
      const prefs = { theme: "light", language: "fr", emailNotifications: false, pushNotifications: true, timezone: "UTC" };
      mockUsersService.updatePreferences.mockResolvedValue(prefs);
      const dto = { theme: "light" as const };

      const result = await controller.updatePreferences("user-1", dto as never, requester);

      expect(mockUsersService.updatePreferences).toHaveBeenCalledWith("user-1", "user-1", "USER", dto);
      expect(result).toBe(prefs);
    });
  });
});
