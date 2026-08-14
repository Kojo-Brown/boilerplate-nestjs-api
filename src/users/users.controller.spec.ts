import { Test, TestingModule } from "@nestjs/testing";
import {
  BadRequestException,
  ForbiddenException,
  PreconditionFailedException,
} from "@nestjs/common";
import { CACHE_MANAGER } from "@nestjs/cache-manager";
import { UsersController } from "./users.controller";
import { UsersService } from "./users.service";
import { UserAccessPolicy } from "./users.access-policy";
import { StorageService } from "@/storage/storage.service";
import { versioned } from "@/common/concurrency";
import type { ExpectedVersion } from "@/common/concurrency";
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
  version: 0,
};

const requester: AuthenticatedUser = { id: "user-1", email: "test@example.com", role: "USER" };

const mockUsersService = {
  listUsers: jest.fn(),
  findById: jest.fn(),
  assertPrecondition: jest.fn(),
  updateSelf: jest.fn(),
  updateAvatar: jest.fn(),
  remove: jest.fn(),
  getPreferences: jest.fn(),
  updatePreferences: jest.fn(),
};

const mockStorageService = {
  uploadBuffer: jest.fn(),
};

// The controller is decorated with HttpCacheInterceptor, which Nest instantiates
// while building the testing module — so CACHE_MANAGER has to be resolvable here.
const mockCacheManager = {
  get: jest.fn(),
  set: jest.fn(),
  del: jest.fn(),
  mdel: jest.fn(),
  clear: jest.fn(),
};

describe("UsersController", () => {
  let controller: UsersController;

  beforeEach(async () => {
    jest.resetAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      controllers: [UsersController],
      providers: [
        { provide: UsersService, useValue: mockUsersService },
        // The real policy: it is pure decision logic, and stubbing it would
        // mean the ownership rule on avatar upload was never actually asserted.
        UserAccessPolicy,
        { provide: StorageService, useValue: mockStorageService },
        { provide: CACHE_MANAGER, useValue: mockCacheManager },
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
      expect(result).toEqual(versioned(mockUser, 0));
    });
  });

  describe("update()", () => {
    it("delegates to UsersService.updateSelf with requester info", async () => {
      const updated = { ...mockUser, name: "New Name" };
      mockUsersService.updateSelf.mockResolvedValue(updated);
      const dto = { name: "New Name" };

      const result = await controller.update("user-1", dto, requester, ifMatch(0));

      expect(mockUsersService.updateSelf).toHaveBeenCalledWith(
        requester,
        "user-1",
        dto,
        ifMatch(0),
      );
      expect(result).toEqual(versioned(updated, updated.version));
    });

    it("wraps the result so the response carries the version it wrote", async () => {
      mockUsersService.updateSelf.mockResolvedValue({ ...mockUser, version: 4 });

      await expect(controller.update("user-1", {}, requester, ifMatch(3))).resolves.toMatchObject({
        version: 4,
      });
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
      mockUsersService.updateAvatar.mockResolvedValue({
        ...mockUser,
        avatarUrl: "avatars/user-1/photo.jpg",
      });

      const result = await controller.uploadAvatar("user-1", file, requester, ifMatch(0));

      expect(mockStorageService.uploadBuffer).toHaveBeenCalledWith(
        expect.stringContaining("avatars/user-1/"),
        file.buffer,
        "image/jpeg",
      );
      expect(mockUsersService.updateAvatar).toHaveBeenCalled();
      expect(result).toMatchObject({
        body: { avatarUrl: expect.stringContaining("avatars/user-1/") },
      });
    });

    it("checks the precondition before spending an upload on a request that cannot win", async () => {
      mockUsersService.assertPrecondition.mockRejectedValue(
        new PreconditionFailedException("stale"),
      );

      await expect(controller.uploadAvatar("user-1", file, requester, ifMatch(0))).rejects.toThrow(
        PreconditionFailedException,
      );

      expect(mockStorageService.uploadBuffer).not.toHaveBeenCalled();
      expect(mockUsersService.updateAvatar).not.toHaveBeenCalled();
    });

    it("passes the precondition through to the write, not only to the pre-check", async () => {
      mockStorageService.uploadBuffer.mockResolvedValue(undefined);
      mockUsersService.updateAvatar.mockResolvedValue(mockUser);

      await controller.uploadAvatar("user-1", file, requester, ifMatch(2));

      expect(mockUsersService.updateAvatar).toHaveBeenCalledWith(
        "user-1",
        expect.any(String),
        ifMatch(2),
      );
    });

    it("throws BadRequestException when no file is provided", async () => {
      await expect(
        controller.uploadAvatar("user-1", undefined, requester, ifMatch(0)),
      ).rejects.toThrow(BadRequestException);
    });

    it("throws ForbiddenException when a non-admin user uploads for another user", async () => {
      const otherRequester: AuthenticatedUser = {
        id: "other-user",
        email: "other@example.com",
        role: "USER",
      };

      await expect(
        controller.uploadAvatar("user-1", file, otherRequester, ifMatch(0)),
      ).rejects.toThrow(ForbiddenException);
      expect(mockStorageService.uploadBuffer).not.toHaveBeenCalled();
    });

    it("allows an ADMIN to upload avatar for another user", async () => {
      const adminRequester: AuthenticatedUser = {
        id: "admin-1",
        email: "admin@example.com",
        role: "ADMIN",
      };
      mockStorageService.uploadBuffer.mockResolvedValue(undefined);
      mockUsersService.updateAvatar.mockResolvedValue({
        ...mockUser,
        avatarUrl: "avatars/user-1/x.jpg",
      });

      await expect(
        controller.uploadAvatar("user-1", file, adminRequester, ifMatch(0)),
      ).resolves.toBeDefined();
    });
  });

  describe("remove()", () => {
    it("delegates to UsersService.remove", async () => {
      mockUsersService.remove.mockResolvedValue(undefined);

      await controller.remove("user-1", ifMatch(0));

      expect(mockUsersService.remove).toHaveBeenCalledWith("user-1", ifMatch(0));
    });
  });

  describe("getPreferences()", () => {
    it("delegates to UsersService.getPreferences with requester info", async () => {
      const prefs = {
        theme: "dark",
        language: "en",
        emailNotifications: true,
        pushNotifications: false,
        timezone: "UTC",
      };
      mockUsersService.getPreferences.mockResolvedValue({ preferences: prefs, version: 2 });

      const result = await controller.getPreferences("user-1", requester);

      expect(mockUsersService.getPreferences).toHaveBeenCalledWith(requester, "user-1");
      // The version comes back on the wrapper, not in the body: preferences are
      // a projection of the user row and have no version field of their own.
      expect(result).toEqual(versioned(prefs, 2));
    });
  });

  describe("updatePreferences()", () => {
    it("delegates to UsersService.updatePreferences with requester info", async () => {
      const prefs = {
        theme: "light",
        language: "fr",
        emailNotifications: false,
        pushNotifications: true,
        timezone: "UTC",
      };
      mockUsersService.updatePreferences.mockResolvedValue({ preferences: prefs, version: 3 });
      const dto = { theme: "light" as const };

      const result = await controller.updatePreferences(
        "user-1",
        dto as never,
        requester,
        ifMatch(2),
      );

      expect(mockUsersService.updatePreferences).toHaveBeenCalledWith(
        requester,
        "user-1",
        dto,
        ifMatch(2),
      );
      expect(result).toEqual(versioned(prefs, 3));
    });
  });
});

/** The `If-Match` a client sends after reading version `version`. */
function ifMatch(version: number): ExpectedVersion {
  return {
    mode: "list",
    tags: [{ weak: false, opaque: String(version), version }],
  };
}
