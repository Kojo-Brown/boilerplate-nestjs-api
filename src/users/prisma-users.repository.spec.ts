import { Test, TestingModule } from "@nestjs/testing";
import { PrismaUsersRepository } from "./prisma-users.repository";
import { PrismaService } from "@/common/prisma/prisma.service";
import type { User } from "@prisma/client";
import type { UserPreferences } from "./types/user-preferences";
import { Role } from "@prisma/client";
import { UNCONDITIONAL } from "@/common/concurrency";
import type { ExpectedVersion } from "@/common/concurrency";

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
  version: 0,
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

describe("PrismaUsersRepository", () => {
  let repo: PrismaUsersRepository;

  beforeEach(async () => {
    jest.resetAllMocks();
    mockPrisma.withExtensions.mockReturnValue({
      user: { getPreferences: mockGetPreferences, setPreferences: mockSetPreferences },
    });

    const module: TestingModule = await Test.createTestingModule({
      providers: [PrismaUsersRepository, { provide: PrismaService, useValue: mockPrisma }],
    }).compile();

    repo = module.get(PrismaUsersRepository);
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

      expect(mockPrisma.user.findUnique).toHaveBeenCalledWith({
        where: { email: "test@example.com" },
      });
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
      const updated = { ...baseUser, name: "Updated", version: 1 };
      mockPrisma.user.update.mockResolvedValue(updated);

      const result = await repo.update("user-1", { name: "Updated" }, UNCONDITIONAL);

      expect(mockPrisma.user.update).toHaveBeenCalledWith({
        where: { id: "user-1" },
        data: { name: "Updated", version: { increment: 1 } },
      });
      expect(result).toBe(updated);
    });

    it("adds no version filter for an unconditional write", async () => {
      mockPrisma.user.update.mockResolvedValue(baseUser);

      await repo.update("user-1", { name: "Updated" }, UNCONDITIONAL);

      expect(mockPrisma.user.update).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: "user-1" } }),
      );
    });

    it("narrows the where clause to the expected versions", async () => {
      mockPrisma.user.update.mockResolvedValue(baseUser);

      await repo.update("user-1", { name: "Updated" }, ifMatch(3, 4));

      expect(mockPrisma.user.update).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: "user-1", version: { in: [3, 4] } } }),
      );
    });

    it("drops entity-tags it never issued, leaving a filter that matches nothing", async () => {
      mockPrisma.user.update.mockResolvedValue(baseUser);

      await repo.update(
        "user-1",
        { name: "Updated" },
        { mode: "list", tags: [{ weak: false, opaque: "deadbeef", version: null }] },
      );

      expect(mockPrisma.user.update).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: "user-1", version: { in: [] } } }),
      );
    });

    it("reclassifies a failed conditional write as a conflict when the row moved", async () => {
      mockPrisma.user.update.mockRejectedValue(new Error("P2025"));
      mockPrisma.user.findUnique.mockResolvedValue({ version: 7 });

      await expect(repo.update("user-1", { name: "x" }, ifMatch(3))).rejects.toMatchObject({
        name: "VersionConflictError",
        currentVersion: 7,
      });
    });

    it("rethrows the original failure when the row is simply gone", async () => {
      const original = new Error("P2025");
      mockPrisma.user.update.mockRejectedValue(original);
      mockPrisma.user.findUnique.mockResolvedValue(null);

      await expect(repo.update("user-1", { name: "x" }, ifMatch(3))).rejects.toBe(original);
    });

    it("rethrows the original failure when the version was never the problem", async () => {
      // A unique-constraint violation, a dead connection — anything that fails
      // a write the precondition would have allowed. Reporting 412 for these
      // would send the client round a re-read loop that cannot fix them.
      const original = new Error("connection terminated");
      mockPrisma.user.update.mockRejectedValue(original);
      mockPrisma.user.findUnique.mockResolvedValue({ version: 3 });

      await expect(repo.update("user-1", { name: "x" }, ifMatch(3))).rejects.toBe(original);
    });
  });

  describe("delete()", () => {
    it("calls prisma.user.delete with the correct id", async () => {
      mockPrisma.user.delete.mockResolvedValue(baseUser);

      const result = await repo.delete("user-1", UNCONDITIONAL);

      expect(mockPrisma.user.delete).toHaveBeenCalledWith({ where: { id: "user-1" } });
      expect(result).toBe(baseUser);
    });

    it("narrows the where clause to the expected versions", async () => {
      mockPrisma.user.delete.mockResolvedValue(baseUser);

      await repo.delete("user-1", ifMatch(2));

      expect(mockPrisma.user.delete).toHaveBeenCalledWith({
        where: { id: "user-1", version: { in: [2] } },
      });
    });
  });

  describe("getPreferences()", () => {
    it("delegates to extended.user.getPreferences", async () => {
      const prefs: UserPreferences = {
        theme: "dark",
        language: "en",
        emailNotifications: true,
        smsNotifications: false,
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
        smsNotifications: true,
        pushNotifications: true,
        timezone: "Europe/Paris",
      };
      const written = { preferences: prefs, version: 4 };
      mockSetPreferences.mockResolvedValue(written);

      const result = await repo.setPreferences("user-1", { theme: "light" }, UNCONDITIONAL);

      expect(mockSetPreferences).toHaveBeenCalledWith("user-1", { theme: "light" }, undefined);
      expect(result).toBe(written);
    });

    it("passes the expected versions to the extension as a Prisma filter", async () => {
      mockSetPreferences.mockResolvedValue({ preferences: {}, version: 4 });

      await repo.setPreferences("user-1", { theme: "light" }, ifMatch(3));

      expect(mockSetPreferences).toHaveBeenCalledWith("user-1", { theme: "light" }, { in: [3] });
    });

    it("reclassifies a stale preference write as a conflict", async () => {
      mockSetPreferences.mockRejectedValue(new Error("P2025"));
      mockPrisma.user.findUnique.mockResolvedValue({ version: 9 });

      await expect(
        repo.setPreferences("user-1", { theme: "light" }, ifMatch(3)),
      ).rejects.toMatchObject({ name: "VersionConflictError", currentVersion: 9 });
    });
  });
});

/** The `If-Match` a client sends after reading one of `versions`. */
function ifMatch(...versions: number[]): ExpectedVersion {
  return {
    mode: "list",
    tags: versions.map((version) => ({ weak: false, opaque: String(version), version })),
  };
}
