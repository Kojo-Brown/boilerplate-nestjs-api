import { Test, TestingModule } from "@nestjs/testing";
import { JwtService } from "@nestjs/jwt";
import { ConfigService } from "@nestjs/config";
import { ConflictException, UnauthorizedException } from "@nestjs/common";
import { Role } from "@prisma/client";
import { AuthService } from "./auth.service";
import { UsersService } from "@/users/users.service";
import { PrismaService } from "@/common/prisma/prisma.service";
import type { User } from "@prisma/client";

jest.mock("argon2", () => ({
  hash: jest.fn(),
  verify: jest.fn(),
}));

// eslint-disable-next-line @typescript-eslint/no-require-imports
const argon2 = require("argon2") as { hash: jest.Mock; verify: jest.Mock };

const mockUser: User = {
  id: "user-1",
  email: "test@example.com",
  password: "hashed-password",
  name: "Test User",
  role: Role.USER,
  provider: null,
  createdAt: new Date("2024-01-01"),
  updatedAt: new Date("2024-01-01"),
};

const mockUsersService = {
  findByEmail: jest.fn(),
  create: jest.fn(),
};

const mockJwtService = {
  sign: jest.fn(),
};

const mockConfigService = {
  get: jest.fn(),
  getOrThrow: jest.fn(),
};

const mockRefreshToken = {
  create: jest.fn(),
  findUnique: jest.fn(),
  delete: jest.fn(),
  deleteMany: jest.fn(),
};

const mockPrismaService = { refreshToken: mockRefreshToken };

describe("AuthService", () => {
  let service: AuthService;

  beforeEach(async () => {
    jest.resetAllMocks();
    mockJwtService.sign.mockReturnValue("mock-access-token");
    mockConfigService.get.mockReturnValue("7d");
    mockConfigService.getOrThrow.mockReturnValue("test-secret");

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: UsersService, useValue: mockUsersService },
        { provide: JwtService, useValue: mockJwtService },
        { provide: ConfigService, useValue: mockConfigService },
        { provide: PrismaService, useValue: mockPrismaService },
      ],
    }).compile();

    service = module.get<AuthService>(AuthService);
  });

  describe("register", () => {
    it("throws ConflictException when email already in use", async () => {
      mockUsersService.findByEmail.mockResolvedValue(mockUser);

      await expect(
        service.register({ email: "test@example.com", password: "password123" }),
      ).rejects.toThrow(ConflictException);

      expect(mockUsersService.create).not.toHaveBeenCalled();
    });

    it("hashes password, creates user, and returns tokens", async () => {
      mockUsersService.findByEmail.mockResolvedValue(null);
      argon2.hash.mockResolvedValue("hashed-password");
      mockUsersService.create.mockResolvedValue(mockUser);
      mockRefreshToken.create.mockResolvedValue({
        id: "rt-1",
        token: "refresh-token",
        userId: "user-1",
        expiresAt: new Date(),
        createdAt: new Date(),
      });

      const result = await service.register({ email: "test@example.com", password: "password123" });

      expect(argon2.hash).toHaveBeenCalledWith("password123");
      expect(mockUsersService.create).toHaveBeenCalledWith(
        expect.objectContaining({ email: "test@example.com", password: "hashed-password" }),
      );
      expect(result).toMatchObject({ accessToken: "mock-access-token", expiresIn: 900 });
      expect(typeof result.refreshToken).toBe("string");
    });
  });

  describe("login", () => {
    it("throws UnauthorizedException when user not found", async () => {
      mockUsersService.findByEmail.mockResolvedValue(null);

      await expect(
        service.login({ email: "unknown@example.com", password: "password123" }),
      ).rejects.toThrow(UnauthorizedException);
    });

    it("throws UnauthorizedException when password is wrong", async () => {
      mockUsersService.findByEmail.mockResolvedValue(mockUser);
      argon2.verify.mockResolvedValue(false);

      await expect(
        service.login({ email: "test@example.com", password: "wrong" }),
      ).rejects.toThrow(UnauthorizedException);
    });

    it("returns tokens on valid credentials", async () => {
      mockUsersService.findByEmail.mockResolvedValue(mockUser);
      argon2.verify.mockResolvedValue(true);
      mockRefreshToken.create.mockResolvedValue({
        id: "rt-1",
        token: "refresh-token",
        userId: "user-1",
        expiresAt: new Date(),
        createdAt: new Date(),
      });

      const result = await service.login({ email: "test@example.com", password: "password123" });

      expect(result).toMatchObject({ accessToken: "mock-access-token", expiresIn: 900 });
      expect(typeof result.refreshToken).toBe("string");
    });
  });

  describe("refresh", () => {
    it("throws UnauthorizedException for unknown token", async () => {
      mockRefreshToken.findUnique.mockResolvedValue(null);

      await expect(service.refresh("bad-token")).rejects.toThrow(UnauthorizedException);
    });

    it("throws UnauthorizedException for expired token", async () => {
      mockRefreshToken.findUnique.mockResolvedValue({
        id: "rt-1",
        token: "expired",
        userId: "user-1",
        expiresAt: new Date(Date.now() - 1_000),
        createdAt: new Date(),
        user: mockUser,
      });

      await expect(service.refresh("expired")).rejects.toThrow(UnauthorizedException);
    });

    it("deletes old token and issues new tokens (rotation)", async () => {
      const futureDate = new Date(Date.now() + 86_400_000);
      mockRefreshToken.findUnique.mockResolvedValue({
        id: "rt-1",
        token: "valid-token",
        userId: "user-1",
        expiresAt: futureDate,
        createdAt: new Date(),
        user: mockUser,
      });
      mockRefreshToken.delete.mockResolvedValue({ id: "rt-1" });
      mockRefreshToken.create.mockResolvedValue({
        id: "rt-2",
        token: "new-token",
        userId: "user-1",
        expiresAt: new Date(Date.now() + 86_400_000 * 7),
        createdAt: new Date(),
      });

      const result = await service.refresh("valid-token");

      expect(mockRefreshToken.delete).toHaveBeenCalledWith({ where: { id: "rt-1" } });
      expect(result).toMatchObject({ accessToken: "mock-access-token", expiresIn: 900 });
    });
  });

  describe("logout", () => {
    it("deletes the refresh token from the database", async () => {
      mockRefreshToken.deleteMany.mockResolvedValue({ count: 1 });

      await service.logout("my-token");

      expect(mockRefreshToken.deleteMany).toHaveBeenCalledWith({
        where: { token: "my-token" },
      });
    });
  });
});
