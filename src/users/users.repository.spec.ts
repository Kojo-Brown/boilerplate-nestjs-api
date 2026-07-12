import { Test, TestingModule } from "@nestjs/testing";
import { UsersRepository } from "./users.repository";
import { PrismaService } from "@/common/prisma/prisma.service";
import type { User } from "@prisma/client";
import type { UserPreferences } from "./types/user-preferences";
import { Role } from "@prisma/client";

const baseUser: User = {
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

const mockGetPreferences = jest.fn();
const mockSetPreferences = jest.fn();

const mockPrisma = {
  user: {
    findUnique: jest.fn(),
    findFirst: jest.fn(),
    findMany: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
  },
  withExtensions: jest.fn().mockReturnValue({
    user: {
      getPreferences: mockGetPreferences,
      setPreferences: mockSetPreferences,
    },
  }),
};

describe("UsersRepository", () => {
  let repo: UsersRepository;

  beforeEach(async () => {
    jest.resetAllMocks();
    mockPrisma.withExtensions.mockReturnValue({
      user: { getPreferences: mockGetPreferences, setPreferences: mockSetPreferences },
    });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        UsersRepository,
        { provide: PrismaService, useValue: mockPrisma },
      ],
    }).compile();

    repo = module.get(UsersRepository);
  });

  it("should be defined", () => {
    expect(repo).toBeDefined();
  });

  describe("findById()", () => {
    it("calls prisma.user.findUnique with correct where clause", async () => {
      mockPrisma.user.findUnique.mockResolvedValue(baseUser);

      const result = await repo.findById("user-1");

      expect(mockPrisma.user.findUnique).toHaveBeenCalledWith({ where: { id: "user-1" } });
      expect(result).toBe(baseUser);
    });
  });

  describe("findByEmail()", () => {
    it("calls prisma.user.findUnique with email", async () => {
      mockPrisma.user.findUnique.mockResolvedValue(baseUser);

      const result = await repo.findByEmail("test@example.com");

      expect(mockPrisma.user.findUnique).toHaveBeenCalledWith({ where: { email: "test@example.com" } });
      expect(result).toBe(baseUser);
    });
  });

  describe("findByProviderAccount()", () => {
    it("calls prisma.user.findFirst with provider and providerAccountId", async () => {
      mockPrisma.user.findFirst.mockResolvedValue(baseUser);

      const result = await repo.findByProviderAccount("google", "g-123");

      expect(mockPrisma.user.findFirst).toHaveBeenCalledWith({
        where: { provider: "google", providerAccountId: "g-123" },
      });
      expect(result).toBe(baseUser);
    });
  });

  describe("findMany()", () => {
    it("queries without cursor or search when not provided", async () => {
      mockPrisma.user.findMany.mockResolvedValue([baseUser]);

      await repo.findMany({ limit: 10 });

      expect(mockPrisma.user.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ take: 11, skip: 0, cursor: undefined }),
      );
    });

    it("applies cursor and search when provided", async () => {
      mockPrisma.user.findMany.mockResolvedValue([baseUser]);

      await repo.findMany({ limit: 5, cursor: "user-1", search: "alice" });

      expect(mockPrisma.user.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          take: 6,
          cursor: { id: "user-1" },
          skip: 1,
          where: expect.objectContaining({ OR: expect.any(Array) }),
        }),
      );
    });
  });

  describe("create()", () => {
    it("calls prisma.user.create and returns the new user", async () => {
      mockPrisma.user.create.mockResolvedValue(baseUser);

      const result = await repo.create({ email: "test@example.com", password: "hashed" });

      expect(mockPrisma.user.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ email: "test@example.com" }) }),
      );
      expect(result).toBe(baseUser);
    });
  });

  describe("update()", () => {
    it("calls prisma.user.update with the correct id and data", async () => {
      const updated = { ...baseUser, name: "Updated" };
      mockPrisma.user.update.mockResolvedValue(updated);

      const result = await repo.update("user-1", { name: "Updated" });

      expect(mockPrisma.user.update).toHaveBeenCalledWith({
        where: { id: "user-1" },
        data: { name: "Updated" },
      });
      expect(result).toBe(updated);
    });
  });

  describe("delete()", () => {
    it("calls prisma.user.delete with the correct id", async () => {
      mockPrisma.user.delete.mockResolvedValue(baseUser);

      const result = await repo.delete("user-1");

      expect(mockPrisma.user.delete).toHaveBeenCalledWith({ where: { id: "user-1" } });
      expect(result).toBe(baseUser);
    });
  });

  describe("getPreferences()", () => {
    it("delegates to extended.user.getPreferences", async () => {
      const prefs: UserPreferences = {
        theme: "dark",
        language: "en",
        emailNotifications: true,
        pushNotifications: false,
        timezone: "UTC",
      };
      mockGetPreferences.mockResolvedValue(prefs);

      const result = await repo.getPreferences("user-1");

      expect(mockGetPreferences).toHaveBeenCalledWith("user-1");
      expect(result).toBe(prefs);
    });
  });

  describe("setPreferences()", () => {
    it("delegates to extended.user.setPreferences", async () => {
      const prefs: UserPreferences = {
        theme: "light",
        language: "fr",
        emailNotifications: false,
        pushNotifications: true,
        timezone: "Europe/Paris",
      };
      mockSetPreferences.mockResolvedValue(prefs);

      const result = await repo.setPreferences("user-1", { theme: "light" });

      expect(mockSetPreferences).toHaveBeenCalledWith("user-1", { theme: "light" });
      expect(result).toBe(prefs);
    });
  });
});
