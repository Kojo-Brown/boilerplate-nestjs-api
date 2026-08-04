import { Test, TestingModule } from "@nestjs/testing";
import { ForbiddenException, NotFoundException } from "@nestjs/common";
import { Role } from "@prisma/client";
import { UsersService, USERS_LIST_CACHE_KEY, userCacheKey } from "./users.service";
import { UserAccessPolicy } from "./users.access-policy";
import { USER_PREFERENCES_STORE, USER_READER, USER_WRITER } from "./ports";
import { CacheService } from "@/common/cache";
import { InMemoryUsersRepository } from "@/test-utils/in-memory-users.repository";
import { DEFAULT_USER_PREFERENCES } from "./types/user-preferences";
import type { RequesterIdentity } from "./users.access-policy";

/**
 * The store is the real (contract-tested) in-memory implementation rather than
 * a bag of `jest.fn()`s: it is bound to the same tokens the Prisma adapter is,
 * so these tests exercise the service's actual behaviour instead of asserting
 * that it called the methods the mock happens to expose. Only the cache is a
 * spy, because cache invalidation is a side effect with nothing to observe.
 */
const mockCache = {
  get: jest.fn(),
  set: jest.fn(),
  del: jest.fn().mockResolvedValue(undefined),
  delMany: jest.fn().mockResolvedValue(undefined),
  reset: jest.fn(),
};

const asUser = (id: string): RequesterIdentity => ({ id, role: Role.USER });
const asAdmin = (id: string): RequesterIdentity => ({ id, role: Role.ADMIN });

describe("UsersService", () => {
  let service: UsersService;
  let store: InMemoryUsersRepository;

  beforeEach(async () => {
    jest.resetAllMocks();
    mockCache.del.mockResolvedValue(undefined);
    mockCache.delMany.mockResolvedValue(undefined);
    store = new InMemoryUsersRepository();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        UsersService,
        UserAccessPolicy,
        { provide: USER_READER, useValue: store },
        { provide: USER_WRITER, useValue: store },
        { provide: USER_PREFERENCES_STORE, useValue: store },
        { provide: CacheService, useValue: mockCache },
      ],
    }).compile();

    service = module.get<UsersService>(UsersService);
  });

  it("resolves every port from the tokens without naming a concrete repository", () => {
    expect(service).toBeDefined();
  });

  describe("findById", () => {
    it("returns user when found", async () => {
      const seeded = store.seed({ id: "user-1", email: "test@example.com" });

      await expect(service.findById("user-1")).resolves.toEqual(seeded);
    });

    it("throws NotFoundException when not found", async () => {
      await expect(service.findById("missing")).rejects.toThrow(NotFoundException);
    });
  });

  describe("findByEmail / findByProviderAccount", () => {
    it("returns null rather than throwing when there is no match", async () => {
      await expect(service.findByEmail("nobody@example.com")).resolves.toBeNull();
      await expect(service.findByProviderAccount("google", "nope")).resolves.toBeNull();
    });

    it("finds a linked provider account", async () => {
      store.seed({
        id: "user-1",
        email: "test@example.com",
        provider: "google",
        providerAccountId: "google-1",
      });

      await expect(service.findByProviderAccount("google", "google-1")).resolves.toMatchObject({
        id: "user-1",
      });
    });
  });

  describe("listUsers", () => {
    it("returns a cursor page of users", async () => {
      store.seed({ id: "user-1", email: "a@example.com" });

      const result = await service.listUsers({ limit: 20 });

      expect(result.items).toHaveLength(1);
      expect(result.hasNextPage).toBe(false);
      expect(result.nextCursor).toBeNull();
    });

    it("sets hasNextPage and nextCursor when more items exist", async () => {
      store.seed({ id: "user-1", email: "a@example.com", createdAt: new Date("2024-01-01") });
      store.seed({ id: "user-2", email: "b@example.com", createdAt: new Date("2024-01-02") });

      const result = await service.listUsers({ limit: 1 });

      expect(result.items).toHaveLength(1);
      expect(result.hasNextPage).toBe(true);
      expect(result.nextCursor).not.toBeNull();
    });

    it("decodes the cursor before handing it to the store", async () => {
      store.seed({ id: "user-1", email: "a@example.com", createdAt: new Date("2024-01-01") });
      store.seed({ id: "user-2", email: "b@example.com", createdAt: new Date("2024-01-02") });
      const firstPage = await service.listUsers({ limit: 1 });

      const secondPage = await service.listUsers({
        limit: 1,
        cursor: firstPage.nextCursor ?? undefined,
      });

      expect(secondPage.items.map((u) => u.id)).toEqual(["user-2"]);
    });

    it("passes the search term through", async () => {
      store.seed({ id: "user-1", email: "ada@example.com", name: "Ada" });
      store.seed({ id: "user-2", email: "grace@example.com", name: "Grace" });

      const result = await service.listUsers({ limit: 20, search: "grace" });

      expect(result.items.map((u) => u.id)).toEqual(["user-2"]);
    });
  });

  describe("create", () => {
    it("persists the user through the writer port", async () => {
      const created = await service.create({ email: "test@example.com", password: "hash" });

      expect(created.email).toBe("test@example.com");
      await expect(service.findById(created.id)).resolves.toMatchObject({
        email: "test@example.com",
      });
    });
  });

  describe("update", () => {
    it("updates the row and invalidates both cache keys", async () => {
      store.seed({ id: "user-1", email: "test@example.com", name: "Test User" });

      const result = await service.update("user-1", { name: "Updated" });

      expect(result.name).toBe("Updated");
      expect(mockCache.delMany).toHaveBeenCalledWith([
        userCacheKey("user-1"),
        USERS_LIST_CACHE_KEY,
      ]);
    });

    it("throws NotFoundException for missing user without touching the cache", async () => {
      await expect(service.update("missing", { name: "X" })).rejects.toThrow(NotFoundException);
      expect(mockCache.delMany).not.toHaveBeenCalled();
    });
  });

  describe("updateSelf", () => {
    beforeEach(() => {
      store.seed({ id: "user-1", email: "test@example.com", name: "Test User" });
    });

    it("allows a user to update their own profile", async () => {
      const result = await service.updateSelf(asUser("user-1"), "user-1", { name: "New Name" });

      expect(result.name).toBe("New Name");
    });

    it("allows ADMIN to update any profile", async () => {
      const result = await service.updateSelf(asAdmin("admin-1"), "user-1", { name: "Changed" });

      expect(result.name).toBe("Changed");
    });

    it("throws ForbiddenException when a non-admin updates another user", async () => {
      await expect(
        service.updateSelf(asUser("user-2"), "user-1", { name: "Hack" }),
      ).rejects.toThrow(ForbiddenException);

      await expect(service.findById("user-1")).resolves.toMatchObject({ name: "Test User" });
    });
  });

  describe("updateAvatar", () => {
    it("stores the object key and invalidates the cache", async () => {
      store.seed({ id: "user-1", email: "test@example.com" });

      const result = await service.updateAvatar("user-1", "avatars/user-1/1.png");

      expect(result.avatarUrl).toBe("avatars/user-1/1.png");
      expect(mockCache.delMany).toHaveBeenCalledWith([
        userCacheKey("user-1"),
        USERS_LIST_CACHE_KEY,
      ]);
    });

    it("throws NotFoundException for a missing user", async () => {
      await expect(service.updateAvatar("missing", "avatars/x.png")).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe("remove", () => {
    it("deletes the user and invalidates cache", async () => {
      store.seed({ id: "user-1", email: "test@example.com" });

      await service.remove("user-1");

      await expect(service.findById("user-1")).rejects.toThrow(NotFoundException);
      expect(mockCache.delMany).toHaveBeenCalledWith([
        userCacheKey("user-1"),
        USERS_LIST_CACHE_KEY,
      ]);
    });

    it("throws NotFoundException for missing user", async () => {
      await expect(service.remove("missing")).rejects.toThrow(NotFoundException);
    });
  });

  describe("getPreferences", () => {
    beforeEach(async () => {
      store.seed({ id: "user-1", email: "test@example.com" });
      await store.setPreferences("user-1", { theme: "dark" });
    });

    it("returns preferences for own user", async () => {
      await expect(service.getPreferences(asUser("user-1"), "user-1")).resolves.toEqual({
        ...DEFAULT_USER_PREFERENCES,
        theme: "dark",
      });
    });

    it("allows ADMIN to read any user's preferences", async () => {
      await expect(service.getPreferences(asAdmin("admin-99"), "user-1")).resolves.toEqual({
        ...DEFAULT_USER_PREFERENCES,
        theme: "dark",
      });
    });

    it("throws ForbiddenException when a non-admin reads another user's preferences", async () => {
      await expect(service.getPreferences(asUser("user-2"), "user-1")).rejects.toThrow(
        ForbiddenException,
      );
    });

    it("throws NotFoundException for missing user", async () => {
      await expect(service.getPreferences(asUser("missing"), "missing")).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe("updatePreferences", () => {
    beforeEach(() => {
      store.seed({ id: "user-1", email: "test@example.com" });
    });

    it("merges the patch and evicts the preferences cache entry", async () => {
      await expect(
        service.updatePreferences(asUser("user-1"), "user-1", { theme: "light" }),
      ).resolves.toEqual({ ...DEFAULT_USER_PREFERENCES, theme: "light" });
      expect(mockCache.del).toHaveBeenCalledWith(`${userCacheKey("user-1")}:prefs`);
    });

    it("allows ADMIN to update any user's preferences", async () => {
      await expect(
        service.updatePreferences(asAdmin("admin-99"), "user-1", { theme: "light" }),
      ).resolves.toMatchObject({ theme: "light" });
    });

    it("throws ForbiddenException when a non-admin updates another user's preferences", async () => {
      await expect(
        service.updatePreferences(asUser("user-2"), "user-1", { theme: "dark" }),
      ).rejects.toThrow(ForbiddenException);
    });

    it("throws NotFoundException for missing user", async () => {
      await expect(service.updatePreferences(asUser("missing"), "missing", {})).rejects.toThrow(
        NotFoundException,
      );
    });
  });
});
