import { Test, TestingModule } from "@nestjs/testing";
import { PrismaUsersRepository } from "./prisma-users.repository";
import { PrismaService } from "@/common/prisma/prisma.service";
import type { User } from "@prisma/client";
import type { UserPreferences } from "./types/user-preferences";
import { Role } from "@prisma/client";
import { UNCONDITIONAL } from "@/common/concurrency";
import { runInTenant } from "@/tenancy/tenant-context";
import { tenantSetting } from "@/tenancy/tenant-prisma";
import type { Prisma } from "@prisma/client";
import type { ExpectedVersion } from "@/common/concurrency";

const baseUser: User = {
  id: "user-1",
  tenantId: "default",
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

/**
 * One set of delegate mocks, reached two ways.
 *
 * The repository reads through the tenant-scoped client `withExtensions()` returns
 * and writes through the client of a transaction it opens, so a spec that asserted
 * on `prisma.user.*` would now be asserting on a delegate nothing calls. Sharing
 * the mocks between both surfaces keeps every assertion below about *what* was
 * queried rather than about which client it reached.
 */
const userDelegate = {
  findUnique: jest.fn(),
  findFirst: jest.fn(),
  findMany: jest.fn(),
  create: jest.fn(),
  update: jest.fn(),
  delete: jest.fn(),
};

/** The `set_config` the transaction opens with. See `setTransactionTenant`. */
const executeRaw = jest.fn();

const mockPrisma = {
  withExtensions: jest.fn(),
  $transaction: jest.fn(),
};

describe("PrismaUsersRepository", () => {
  let repo: PrismaUsersRepository;

  beforeEach(async () => {
    jest.resetAllMocks();
    mockPrisma.withExtensions.mockReturnValue({
      user: {
        ...userDelegate,
        getPreferences: mockGetPreferences,
        setPreferences: mockSetPreferences,
      },
    });
    // The interactive form, which is what the write path uses: the callback is
    // handed a client whose statements are all in one transaction — the only
    // arrangement in which the transaction-local tenant setting applies to the
    // write after it.
    mockPrisma.$transaction.mockImplementation((work: (client: unknown) => Promise<unknown>) =>
      work({ ...mockPrisma, user: userDelegate, $executeRaw: executeRaw }),
    );

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
      userDelegate.findUnique.mockResolvedValue(baseUser);

      const result = await repo.findById("user-1");

      expect(userDelegate.findUnique).toHaveBeenCalledWith({ where: { id: "user-1" } });
      expect(result).toBe(baseUser);
    });
  });

  describe("findByEmail()", () => {
    it("calls prisma.user.findUnique with email", async () => {
      userDelegate.findUnique.mockResolvedValue(baseUser);

      const result = await repo.findByEmail("test@example.com");

      expect(userDelegate.findUnique).toHaveBeenCalledWith({
        where: { email: "test@example.com" },
      });
      expect(result).toBe(baseUser);
    });
  });

  describe("findByProviderAccount()", () => {
    it("calls prisma.user.findFirst with provider and providerAccountId", async () => {
      userDelegate.findFirst.mockResolvedValue(baseUser);

      const result = await repo.findByProviderAccount("google", "g-123");

      expect(userDelegate.findFirst).toHaveBeenCalledWith({
        where: { provider: "google", providerAccountId: "g-123" },
      });
      expect(result).toBe(baseUser);
    });
  });

  describe("findMany()", () => {
    it("queries without cursor or search when not provided", async () => {
      userDelegate.findMany.mockResolvedValue([baseUser]);

      await repo.findMany({ limit: 10 });

      expect(userDelegate.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ take: 11, skip: 0, cursor: undefined }),
      );
    });

    it("applies cursor and search when provided", async () => {
      userDelegate.findMany.mockResolvedValue([baseUser]);

      await repo.findMany({ limit: 5, cursor: "user-1", search: "alice" });

      expect(userDelegate.findMany).toHaveBeenCalledWith(
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
      userDelegate.create.mockResolvedValue(baseUser);

      const result = await repo.create({ email: "test@example.com", password: "hashed" });

      expect(userDelegate.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ email: "test@example.com" }) }),
      );
      expect(result).toBe(baseUser);
    });
  });

  describe("update()", () => {
    it("calls prisma.user.update with the correct id and data", async () => {
      const updated = { ...baseUser, name: "Updated", version: 1 };
      userDelegate.update.mockResolvedValue(updated);

      const result = await repo.update("user-1", { name: "Updated" }, UNCONDITIONAL);

      expect(userDelegate.update).toHaveBeenCalledWith({
        where: { id: "user-1" },
        data: { name: "Updated", version: { increment: 1 } },
      });
      expect(result).toBe(updated);
    });

    it("adds no version filter for an unconditional write", async () => {
      userDelegate.update.mockResolvedValue(baseUser);

      await repo.update("user-1", { name: "Updated" }, UNCONDITIONAL);

      expect(userDelegate.update).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: "user-1" } }),
      );
    });

    it("narrows the where clause to the expected versions", async () => {
      userDelegate.update.mockResolvedValue(baseUser);

      await repo.update("user-1", { name: "Updated" }, ifMatch(3, 4));

      expect(userDelegate.update).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: "user-1", version: { in: [3, 4] } } }),
      );
    });

    it("drops entity-tags it never issued, leaving a filter that matches nothing", async () => {
      userDelegate.update.mockResolvedValue(baseUser);

      await repo.update(
        "user-1",
        { name: "Updated" },
        { mode: "list", tags: [{ weak: false, opaque: "deadbeef", version: null }] },
      );

      expect(userDelegate.update).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: "user-1", version: { in: [] } } }),
      );
    });

    it("reclassifies a failed conditional write as a conflict when the row moved", async () => {
      userDelegate.update.mockRejectedValue(new Error("P2025"));
      userDelegate.findUnique.mockResolvedValue({ version: 7 });

      await expect(repo.update("user-1", { name: "x" }, ifMatch(3))).rejects.toMatchObject({
        name: "VersionConflictError",
        currentVersion: 7,
      });
    });

    it("rethrows the original failure when the row is simply gone", async () => {
      const original = new Error("P2025");
      userDelegate.update.mockRejectedValue(original);
      userDelegate.findUnique.mockResolvedValue(null);

      await expect(repo.update("user-1", { name: "x" }, ifMatch(3))).rejects.toBe(original);
    });

    it("rethrows the original failure when the version was never the problem", async () => {
      // A unique-constraint violation, a dead connection — anything that fails
      // a write the precondition would have allowed. Reporting 412 for these
      // would send the client round a re-read loop that cannot fix them.
      const original = new Error("connection terminated");
      userDelegate.update.mockRejectedValue(original);
      userDelegate.findUnique.mockResolvedValue({ version: 3 });

      await expect(repo.update("user-1", { name: "x" }, ifMatch(3))).rejects.toBe(original);
    });
  });

  describe("delete()", () => {
    it("calls prisma.user.delete with the correct id", async () => {
      userDelegate.delete.mockResolvedValue(baseUser);

      const result = await repo.delete("user-1", UNCONDITIONAL);

      expect(userDelegate.delete).toHaveBeenCalledWith({ where: { id: "user-1" } });
      expect(result).toBe(baseUser);
    });

    it("narrows the where clause to the expected versions", async () => {
      userDelegate.delete.mockResolvedValue(baseUser);

      await repo.delete("user-1", ifMatch(2));

      expect(userDelegate.delete).toHaveBeenCalledWith({
        where: { id: "user-1", version: { in: [2] } },
      });
    });
  });

  describe("the tenant a write runs under", () => {
    it("opens a transaction and names the tenant in it when the caller has none", async () => {
      userDelegate.create.mockResolvedValue(baseUser);

      await runInTenant("acme", () => repo.create({ email: "a@example.test" }));

      expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);
      // Before the write, not merely during it: the setting is transaction-local,
      // so a `create` that ran first would be refused by `require_tenant_id()`.
      expect(executeRaw).toHaveBeenCalledWith(tenantSetting("acme"));
      expect(executeRaw.mock.invocationCallOrder[0]).toBeLessThan(
        userDelegate.create.mock.invocationCallOrder[0]!,
      );
    });

    it("joins the caller's transaction, which has already named the tenant", async () => {
      userDelegate.create.mockResolvedValue(baseUser);
      const tx = {
        backend: "prisma" as const,
        client: { user: userDelegate } as unknown as Prisma.TransactionClient,
        onRollback: () => undefined,
      };

      await runInTenant("acme", () => repo.create({ email: "a@example.test" }, tx));

      // No second transaction and no second `set_config`: `PrismaTransactionRunner`
      // issued it when it opened this one, and a nested transaction would be a
      // second connection that the caller's uncommitted rows are invisible from.
      expect(mockPrisma.$transaction).not.toHaveBeenCalled();
      expect(executeRaw).not.toHaveBeenCalled();
      expect(userDelegate.create).toHaveBeenCalledTimes(1);
    });

    // The database is what refuses this, not the repository: the policies see a
    // NULL setting, `require_tenant_id()` raises 42501 on the insert, and the
    // write fails closed. Asserting the absence here is what documents that this
    // layer does not quietly supply a tenant of its own.
    it("sets no tenant when there is none in scope", async () => {
      userDelegate.create.mockResolvedValue(baseUser);

      await repo.create({ email: "a@example.test" });

      expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);
      expect(executeRaw).not.toHaveBeenCalled();
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
      userDelegate.findUnique.mockResolvedValue({ version: 9 });

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
