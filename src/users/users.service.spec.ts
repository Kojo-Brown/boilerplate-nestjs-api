import { Test, TestingModule } from "@nestjs/testing";
import { ForbiddenException, NotFoundException, PreconditionFailedException } from "@nestjs/common";
import { Role } from "@prisma/client";
import { UsersService, USERS_LIST_CACHE_KEY, userCacheKey } from "./users.service";
import { UserAccessPolicy } from "./users.access-policy";
import { USER_PREFERENCES_STORE, USER_READER, USER_WRITER } from "./ports";
import { CacheService } from "@/common/cache";
import { PreconditionRequiredException, UNCONDITIONAL } from "@/common/concurrency";
import type { ExpectedVersion } from "@/common/concurrency";
import { TRANSACTION_RUNNER } from "@/common/prisma/transaction.port";
import { OUTBOX_STORE, TransactionalOutbox } from "@/outbox";
import { InMemoryOutboxStore } from "@/test-utils/in-memory-outbox.store";
import { InMemoryTransactionRunner } from "@/test-utils/in-memory-transaction.runner";
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

/**
 * Announcing is no longer a spy.
 *
 * `remove` stages `user.deleted` in the outbox rather than emitting it, and the
 * outbox leaves a row behind — so the assertion can be what was written, which
 * a spy on `publish` could never be. It also means these specs exercise the
 * real `TransactionalOutbox` and the real rollback path: a delete that is
 * refused now has to leave *no* row, not merely make no call.
 */
let outboxStore: InMemoryOutboxStore;
let transactions: InMemoryTransactionRunner;

const staged = () => outboxStore.all().map((row) => ({ name: row.name, payload: row.payload }));

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
    outboxStore = new InMemoryOutboxStore();
    transactions = new InMemoryTransactionRunner();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        UsersService,
        UserAccessPolicy,
        TransactionalOutbox,
        { provide: USER_READER, useValue: store },
        { provide: USER_WRITER, useValue: store },
        { provide: USER_PREFERENCES_STORE, useValue: store },
        { provide: CacheService, useValue: mockCache },
        { provide: OUTBOX_STORE, useValue: outboxStore },
        { provide: TRANSACTION_RUNNER, useValue: transactions },
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

      const result = await service.update("user-1", { name: "Updated" }, UNCONDITIONAL);

      expect(result.name).toBe("Updated");
      expect(mockCache.delMany).toHaveBeenCalledWith([
        userCacheKey("user-1"),
        USERS_LIST_CACHE_KEY,
      ]);
    });

    it("throws NotFoundException for missing user without touching the cache", async () => {
      await expect(service.update("missing", { name: "X" }, UNCONDITIONAL)).rejects.toThrow(
        NotFoundException,
      );
      expect(mockCache.delMany).not.toHaveBeenCalled();
    });
  });

  describe("updateSelf", () => {
    beforeEach(() => {
      store.seed({ id: "user-1", email: "test@example.com", name: "Test User" });
    });

    it("allows a user to update their own profile", async () => {
      const result = await service.updateSelf(
        asUser("user-1"),
        "user-1",
        { name: "New Name" },
        ifMatch(0),
      );

      expect(result.name).toBe("New Name");
    });

    it("allows ADMIN to update any profile", async () => {
      const result = await service.updateSelf(
        asAdmin("admin-1"),
        "user-1",
        { name: "Changed" },
        ifMatch(0),
      );

      expect(result.name).toBe("Changed");
    });

    it("throws ForbiddenException when a non-admin updates another user", async () => {
      await expect(
        service.updateSelf(asUser("user-2"), "user-1", { name: "Hack" }, UNCONDITIONAL),
      ).rejects.toThrow(ForbiddenException);

      await expect(service.findById("user-1")).resolves.toMatchObject({ name: "Test User" });
    });
  });

  describe("updateAvatar", () => {
    it("stores the object key and invalidates the cache", async () => {
      store.seed({ id: "user-1", email: "test@example.com" });

      const result = await service.updateAvatar("user-1", "avatars/user-1/1.png", UNCONDITIONAL);

      expect(result.avatarUrl).toBe("avatars/user-1/1.png");
      expect(mockCache.delMany).toHaveBeenCalledWith([
        userCacheKey("user-1"),
        USERS_LIST_CACHE_KEY,
      ]);
    });

    it("throws NotFoundException for a missing user", async () => {
      await expect(service.updateAvatar("missing", "avatars/x.png", UNCONDITIONAL)).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe("remove", () => {
    it("deletes the user and invalidates cache", async () => {
      store.seed({ id: "user-1", email: "test@example.com" });

      await service.remove("user-1", ifMatch(0));

      await expect(service.findById("user-1")).rejects.toThrow(NotFoundException);
      expect(mockCache.delMany).toHaveBeenCalledWith([
        userCacheKey("user-1"),
        USERS_LIST_CACHE_KEY,
      ]);
    });

    it("throws NotFoundException for missing user", async () => {
      await expect(service.remove("missing", UNCONDITIONAL)).rejects.toThrow(NotFoundException);
    });

    it("stages user.deleted with the address, which nothing can look up afterwards", async () => {
      store.seed({ id: "user-1", email: "test@example.com" });

      await service.remove("user-1", ifMatch(0));

      expect(staged()).toEqual([
        { name: "user.deleted", payload: { userId: "user-1", email: "test@example.com" } },
      ]);
    });

    it("stages the event inside the transaction that deletes the row", async () => {
      store.seed({ id: "user-1", email: "test@example.com" });

      await service.remove("user-1", ifMatch(0));

      // One unit of work, committed once. A second `run` would mean the delete
      // and the event were separately abandonable, which is the failure the
      // outbox exists to remove.
      expect(transactions.started).toBe(1);
      expect(transactions.committed).toBe(1);
    });

    it("keeps the row and the event together when the unit of work fails", async () => {
      store.seed({ id: "user-1", email: "test@example.com" });
      // Fails *after* the delete and before the event is staged, which is the
      // window the whole pattern is about: without one transaction over both,
      // this is a user who is gone with nobody ever told.
      mockCache.delMany.mockRejectedValueOnce(new Error("redis down"));

      await expect(service.remove("user-1", ifMatch(0))).rejects.toThrow("redis down");

      expect(transactions.rolledBack).toBe(1);
      expect(staged()).toEqual([]);
      await expect(service.findById("user-1")).resolves.toMatchObject({ id: "user-1" });
    });

    it("stages nothing when the user does not exist", async () => {
      await expect(service.remove("missing", UNCONDITIONAL)).rejects.toThrow(NotFoundException);

      expect(staged()).toEqual([]);
      expect(transactions.started).toBe(0);
    });
  });

  describe("getPreferences", () => {
    beforeEach(async () => {
      store.seed({ id: "user-1", email: "test@example.com" });
      await store.setPreferences("user-1", { theme: "dark" }, UNCONDITIONAL);
    });

    it("returns preferences for own user", async () => {
      await expect(service.getPreferences(asUser("user-1"), "user-1")).resolves.toEqual({
        preferences: { ...DEFAULT_USER_PREFERENCES, theme: "dark" },
        version: 1,
      });
    });

    it("allows ADMIN to read any user's preferences", async () => {
      await expect(service.getPreferences(asAdmin("admin-99"), "user-1")).resolves.toEqual({
        preferences: { ...DEFAULT_USER_PREFERENCES, theme: "dark" },
        version: 1,
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
        service.updatePreferences(asUser("user-1"), "user-1", { theme: "light" }, ifMatch(0)),
      ).resolves.toEqual({
        preferences: { ...DEFAULT_USER_PREFERENCES, theme: "light" },
        version: 1,
      });
      expect(mockCache.del).toHaveBeenCalledWith(`${userCacheKey("user-1")}:prefs`);
    });

    it("allows ADMIN to update any user's preferences", async () => {
      await expect(
        service.updatePreferences(asAdmin("admin-99"), "user-1", { theme: "light" }, ifMatch(0)),
      ).resolves.toMatchObject({ preferences: { theme: "light" } });
    });

    it("throws ForbiddenException when a non-admin updates another user's preferences", async () => {
      await expect(
        service.updatePreferences(asUser("user-2"), "user-1", { theme: "dark" }, UNCONDITIONAL),
      ).rejects.toThrow(ForbiddenException);
    });

    it("throws NotFoundException for missing user", async () => {
      await expect(
        service.updatePreferences(asUser("missing"), "missing", {}, UNCONDITIONAL),
      ).rejects.toThrow(NotFoundException);
    });
  });
  // ─── Optimistic concurrency ─────────────────────────────────────────────────
  //
  // The store raises `VersionConflictError`; the endpoints answer 412. This is
  // where the one becomes the other, so it is where the translation is pinned.

  describe("conditional writes", () => {
    beforeEach(() => {
      store.seed({ id: "user-1", email: "test@example.com", name: "Test User" });
    });

    it("applies an update whose If-Match names the current version", async () => {
      await expect(
        service.update("user-1", { name: "Updated" }, ifMatch(0)),
      ).resolves.toMatchObject({ name: "Updated", version: 1 });
    });

    it("answers 412 once the row has moved past the version the caller read", async () => {
      await service.update("user-1", { name: "First" }, UNCONDITIONAL);

      await expect(service.update("user-1", { name: "Second" }, ifMatch(0))).rejects.toThrow(
        PreconditionFailedException,
      );
    });

    it("names the version the row is at, so the client knows what to re-read", async () => {
      await service.update("user-1", { name: "First" }, UNCONDITIONAL);

      await expect(service.update("user-1", { name: "Second" }, ifMatch(0))).rejects.toThrow(
        /version 1/,
      );
    });

    it("leaves the cache alone when the write was refused", async () => {
      await service.update("user-1", { name: "First" }, UNCONDITIONAL);
      mockCache.delMany.mockClear();

      await expect(service.update("user-1", { name: "Second" }, ifMatch(0))).rejects.toThrow();

      expect(mockCache.delMany).not.toHaveBeenCalled();
    });

    it("answers 412 rather than deleting against a stale version", async () => {
      await service.update("user-1", { name: "First" }, UNCONDITIONAL);

      await expect(service.remove("user-1", ifMatch(0))).rejects.toThrow(
        PreconditionFailedException,
      );
      await expect(service.findById("user-1")).resolves.toBeDefined();
    });

    it("leaves no staged event when a conditional delete is refused", async () => {
      await service.update("user-1", { name: "First" }, UNCONDITIONAL);
      outboxStore.reset();

      await expect(service.remove("user-1", ifMatch(0))).rejects.toThrow();

      expect(staged()).toEqual([]);
    });

    it("answers 412 on a stale preference write", async () => {
      await service.updatePreferences(asUser("user-1"), "user-1", { theme: "dark" }, ifMatch(0));

      await expect(
        service.updatePreferences(asUser("user-1"), "user-1", { language: "fr" }, ifMatch(0)),
      ).rejects.toThrow(PreconditionFailedException);
    });

    it("moves the user's version when preferences are written, so the two stay in step", async () => {
      await service.updatePreferences(asUser("user-1"), "user-1", { theme: "dark" }, ifMatch(0));

      await expect(service.findById("user-1")).resolves.toMatchObject({ version: 1 });
    });

    it("evicts the user entry too, because preferences live on the user row", async () => {
      await service.updatePreferences(asUser("user-1"), "user-1", { theme: "dark" }, ifMatch(0));

      expect(mockCache.delMany).toHaveBeenCalledWith([
        userCacheKey("user-1"),
        USERS_LIST_CACHE_KEY,
      ]);
    });
  });

  describe("assertPrecondition", () => {
    beforeEach(() => {
      store.seed({ id: "user-1", email: "test@example.com" });
    });

    it("resolves with the row for the current version", async () => {
      await expect(service.assertPrecondition("user-1", ifMatch(0))).resolves.toMatchObject({
        id: "user-1",
      });
    });

    it("throws 412 for a stale one", async () => {
      await service.update("user-1", { name: "Moved" }, UNCONDITIONAL);

      await expect(service.assertPrecondition("user-1", ifMatch(0))).rejects.toThrow(
        PreconditionFailedException,
      );
    });

    it("throws 428 when the caller named no version at all", async () => {
      await expect(service.assertPrecondition("user-1", UNCONDITIONAL)).rejects.toThrow(
        PreconditionRequiredException,
      );
    });

    // RFC 9110 §13.2.1: preconditions are evaluated after the server's normal
    // request checks. A 428 for a row that does not exist would send the client
    // to fetch an ETag it can never obtain.
    it("throws 404 rather than 428 when there is no such user", async () => {
      await expect(service.assertPrecondition("missing", UNCONDITIONAL)).rejects.toThrow(
        NotFoundException,
      );
    });

    it("throws 404 rather than 412 when there is no such user", async () => {
      await expect(service.assertPrecondition("missing", ifMatch(0))).rejects.toThrow(
        NotFoundException,
      );
    });

    it("throws 428 rather than 412 when the caller sent nothing to compare", async () => {
      // The reverse order would tell a client that sent no validator that the
      // one it sent was stale.
      await service.update("user-1", { name: "Moved" }, UNCONDITIONAL);

      await expect(service.assertPrecondition("user-1", UNCONDITIONAL)).rejects.toThrow(
        PreconditionRequiredException,
      );
    });
  });

  describe("required preconditions", () => {
    beforeEach(() => {
      store.seed({ id: "user-1", email: "test@example.com" });
    });

    it("refuses an unconditional profile update from a client", async () => {
      await expect(
        service.updateSelf(asUser("user-1"), "user-1", { name: "X" }, UNCONDITIONAL),
      ).rejects.toThrow(PreconditionRequiredException);
    });

    it("refuses an unconditional preference update from a client", async () => {
      await expect(
        service.updatePreferences(asUser("user-1"), "user-1", { theme: "dark" }, UNCONDITIONAL),
      ).rejects.toThrow(PreconditionRequiredException);
    });

    it("refuses an unconditional delete", async () => {
      await expect(service.remove("user-1", UNCONDITIONAL)).rejects.toThrow(
        PreconditionRequiredException,
      );
    });

    it("checks ownership before the precondition, so a stranger is told 403 and not 428", async () => {
      await expect(
        service.updateSelf(asUser("user-2"), "user-1", { name: "X" }, UNCONDITIONAL),
      ).rejects.toThrow(ForbiddenException);
    });

    it("still allows an internal caller to write unconditionally", async () => {
      // `update` is the entry point for the OAuth link path, which has no
      // version to name. Making it demand one would strand the sign-in.
      await expect(
        service.update("user-1", { provider: "google" }, UNCONDITIONAL),
      ).resolves.toMatchObject({ provider: "google" });
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
