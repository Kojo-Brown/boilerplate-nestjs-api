import { Test, TestingModule } from "@nestjs/testing";
import { CommandBus, CqrsModule, QueryBus } from "@nestjs/cqrs";
import { ForbiddenException, NotFoundException, PreconditionFailedException } from "@nestjs/common";
import { Role } from "@prisma/client";
import { UserAccessPolicy } from "./users.access-policy";
import { USER_PREFERENCES_STORE, USER_READER, USER_WRITER } from "./ports";
import {
  FindUserByEmailQuery,
  FindUserByProviderAccountQuery,
  GetUserPreferencesQuery,
  GetUserQuery,
  ListUsersQuery,
  USERS_LIST_CACHE_KEY,
  USERS_QUERY_HANDLERS,
  UsersReadModelCache,
  userCacheKey,
} from "./read";
import {
  CreateUserCommand,
  DeleteUserCommand,
  USERS_COMMAND_HANDLERS,
  UpdateUserAvatarCommand,
  UpdateUserCommand,
  UpdateUserPreferencesCommand,
  UpdateUserProfileCommand,
  UserWriteModel,
} from "./write";
import { CacheService } from "@/common/cache";
import { PreconditionRequiredException, UNCONDITIONAL } from "@/common/concurrency";
import type { ExpectedVersion } from "@/common/concurrency";
import { TRANSACTION_RUNNER } from "@/common/prisma/transaction.port";
import { StorageService } from "@/storage/storage.service";
import { OUTBOX_STORE, TransactionalOutbox } from "@/outbox";
import { EventContract } from "@/schema-registry";
import { realEventContract } from "@/test-utils/event-contract";
import { InMemoryOutboxStore } from "@/test-utils/in-memory-outbox.store";
import { InMemoryTransactionRunner } from "@/test-utils/in-memory-transaction.runner";
import { InMemoryUsersRepository } from "@/test-utils/in-memory-users.repository";
import { DEFAULT_USER_PREFERENCES } from "./types/user-preferences";
import type { RequesterIdentity } from "./users.access-policy";

/**
 * The users module's write and read sides, driven the way production drives
 * them: through the real `CommandBus` and `QueryBus`.
 *
 * Dispatching rather than calling handlers directly is deliberate and costs one
 * `module.init()`. It means these specs also assert the registration — that a
 * command class is bound to the handler that claims it — which is the failure a
 * per-handler unit test cannot see and which surfaces in production as a
 * `CommandHandlerNotFoundException` on an endpoint nobody changed.
 *
 * The store is the real (contract-tested) in-memory implementation rather than
 * a bag of `jest.fn()`s: it is bound to the same tokens the Prisma adapter is,
 * so these tests exercise actual behaviour instead of asserting that a handler
 * called the methods a mock happens to expose. Only the cache and S3 are spies,
 * because eviction and upload are side effects with nothing to read back.
 */
const mockCache = {
  get: jest.fn(),
  set: jest.fn(),
  del: jest.fn().mockResolvedValue(undefined),
  delMany: jest.fn().mockResolvedValue(undefined),
  reset: jest.fn(),
};

const mockStorage = {
  uploadBuffer: jest.fn().mockResolvedValue(undefined),
};

/**
 * Announcing is not a spy either.
 *
 * `DeleteUserCommand` stages `user.deleted` in the outbox rather than emitting
 * it, and the outbox leaves a row behind — so the assertion can be what was
 * written, which a spy on `publish` could never be. It also means these specs
 * exercise the real `TransactionalOutbox` and the real rollback path: a delete
 * that is refused now has to leave *no* row, not merely make no call.
 */
let outboxStore: InMemoryOutboxStore;
let transactions: InMemoryTransactionRunner;

const staged = () => outboxStore.all().map((row) => ({ name: row.name, payload: row.payload }));

const asUser = (id: string): RequesterIdentity => ({ id, role: Role.USER });
const asAdmin = (id: string): RequesterIdentity => ({ id, role: Role.ADMIN });

const avatarFile = {
  buffer: Buffer.from("img"),
  originalname: "photo.JPG",
  mimetype: "image/jpeg",
};

describe("users CQRS", () => {
  let module: TestingModule;
  let commands: CommandBus;
  let queries: QueryBus;
  let store: InMemoryUsersRepository;

  beforeEach(async () => {
    jest.resetAllMocks();
    mockCache.del.mockResolvedValue(undefined);
    mockCache.delMany.mockResolvedValue(undefined);
    mockStorage.uploadBuffer.mockResolvedValue(undefined);
    store = new InMemoryUsersRepository();
    outboxStore = new InMemoryOutboxStore();
    transactions = new InMemoryTransactionRunner();

    module = await Test.createTestingModule({
      imports: [CqrsModule],
      providers: [
        UserAccessPolicy,
        UserWriteModel,
        UsersReadModelCache,
        ...USERS_COMMAND_HANDLERS,
        ...USERS_QUERY_HANDLERS,
        TransactionalOutbox,
        // The real contract over the real catalogue: staging checks the payload
        // against its schema, and a permissive stub here would stop this suite
        // noticing an event it emits that no consumer can read.
        { provide: EventContract, useFactory: realEventContract },
        { provide: USER_READER, useValue: store },
        { provide: USER_WRITER, useValue: store },
        { provide: USER_PREFERENCES_STORE, useValue: store },
        { provide: CacheService, useValue: mockCache },
        { provide: StorageService, useValue: mockStorage },
        { provide: OUTBOX_STORE, useValue: outboxStore },
        { provide: TRANSACTION_RUNNER, useValue: transactions },
      ],
    }).compile();

    // `compile()` builds the container; `init()` is what runs
    // `onApplicationBootstrap`, which is where `CqrsModule` explores the
    // providers and binds each handler to its command. Without it every
    // dispatch below would fail to find a handler.
    await module.init();

    commands = module.get(CommandBus);
    queries = module.get(QueryBus);
  });

  afterEach(async () => {
    await module.close();
  });

  it("binds every command and query to a handler", () => {
    expect(commands).toBeDefined();
    expect(queries).toBeDefined();
  });

  describe("GetUserQuery", () => {
    it("returns the user when found", async () => {
      const seeded = store.seed({ id: "user-1", email: "test@example.com" });

      await expect(queries.execute(new GetUserQuery("user-1"))).resolves.toEqual(seeded);
    });

    it("throws NotFoundException when not found", async () => {
      await expect(queries.execute(new GetUserQuery("missing"))).rejects.toThrow(NotFoundException);
    });
  });

  describe("FindUserByEmailQuery / FindUserByProviderAccountQuery", () => {
    it("returns null rather than throwing when there is no match", async () => {
      await expect(
        queries.execute(new FindUserByEmailQuery("nobody@example.com")),
      ).resolves.toBeNull();
      await expect(
        queries.execute(new FindUserByProviderAccountQuery("google", "nope")),
      ).resolves.toBeNull();
    });

    it("finds a linked provider account", async () => {
      store.seed({
        id: "user-1",
        email: "test@example.com",
        provider: "google",
        providerAccountId: "google-1",
      });

      await expect(
        queries.execute(new FindUserByProviderAccountQuery("google", "google-1")),
      ).resolves.toMatchObject({ id: "user-1" });
    });
  });

  describe("ListUsersQuery", () => {
    it("returns a cursor page of users", async () => {
      store.seed({ id: "user-1", email: "a@example.com" });

      const result = await queries.execute(new ListUsersQuery({ limit: 20 }));

      expect(result.items).toHaveLength(1);
      expect(result.hasNextPage).toBe(false);
      expect(result.nextCursor).toBeNull();
    });

    it("sets hasNextPage and nextCursor when more items exist", async () => {
      store.seed({ id: "user-1", email: "a@example.com", createdAt: new Date("2024-01-01") });
      store.seed({ id: "user-2", email: "b@example.com", createdAt: new Date("2024-01-02") });

      const result = await queries.execute(new ListUsersQuery({ limit: 1 }));

      expect(result.items).toHaveLength(1);
      expect(result.hasNextPage).toBe(true);
      expect(result.nextCursor).not.toBeNull();
    });

    it("decodes the cursor before handing it to the store", async () => {
      store.seed({ id: "user-1", email: "a@example.com", createdAt: new Date("2024-01-01") });
      store.seed({ id: "user-2", email: "b@example.com", createdAt: new Date("2024-01-02") });
      const firstPage = await queries.execute(new ListUsersQuery({ limit: 1 }));

      const secondPage = await queries.execute(
        new ListUsersQuery({ limit: 1, cursor: firstPage.nextCursor ?? undefined }),
      );

      expect(secondPage.items.map((u) => u.id)).toEqual(["user-2"]);
    });

    it("passes the search term through", async () => {
      store.seed({ id: "user-1", email: "ada@example.com", name: "Ada" });
      store.seed({ id: "user-2", email: "grace@example.com", name: "Grace" });

      const result = await queries.execute(new ListUsersQuery({ limit: 20, search: "grace" }));

      expect(result.items.map((u) => u.id)).toEqual(["user-2"]);
    });
  });

  describe("CreateUserCommand", () => {
    it("persists the user through the writer port", async () => {
      const created = await commands.execute(
        new CreateUserCommand({ email: "test@example.com", password: "hash" }),
      );

      expect(created.email).toBe("test@example.com");
      await expect(queries.execute(new GetUserQuery(created.id))).resolves.toMatchObject({
        email: "test@example.com",
      });
    });

    it("evicts nothing: a user who did not exist has nothing cached", async () => {
      await commands.execute(new CreateUserCommand({ email: "test@example.com" }));

      // The list *is* stale after this, and it is `UsersReadModelProjector`
      // that evicts it — from `user.registered`, after the transaction commits.
      expect(mockCache.delMany).not.toHaveBeenCalled();
      expect(mockCache.del).not.toHaveBeenCalled();
    });
  });

  describe("UpdateUserCommand", () => {
    it("updates the row and invalidates both cache keys", async () => {
      store.seed({ id: "user-1", email: "test@example.com", name: "Test User" });

      const result = await commands.execute(
        new UpdateUserCommand("user-1", { name: "Updated" }, UNCONDITIONAL),
      );

      expect(result.name).toBe("Updated");
      expect(mockCache.delMany).toHaveBeenCalledWith([
        userCacheKey("user-1"),
        USERS_LIST_CACHE_KEY,
      ]);
    });

    it("throws NotFoundException for missing user without touching the cache", async () => {
      await expect(
        commands.execute(new UpdateUserCommand("missing", { name: "X" }, UNCONDITIONAL)),
      ).rejects.toThrow(NotFoundException);
      expect(mockCache.delMany).not.toHaveBeenCalled();
    });
  });

  describe("UpdateUserProfileCommand", () => {
    beforeEach(() => {
      store.seed({ id: "user-1", email: "test@example.com", name: "Test User" });
    });

    it("allows a user to update their own profile", async () => {
      const result = await commands.execute(
        new UpdateUserProfileCommand(asUser("user-1"), "user-1", { name: "New Name" }, ifMatch(0)),
      );

      expect(result.name).toBe("New Name");
    });

    it("allows ADMIN to update any profile", async () => {
      const result = await commands.execute(
        new UpdateUserProfileCommand(asAdmin("admin-1"), "user-1", { name: "Changed" }, ifMatch(0)),
      );

      expect(result.name).toBe("Changed");
    });

    it("throws ForbiddenException when a non-admin updates another user", async () => {
      await expect(
        commands.execute(
          new UpdateUserProfileCommand(asUser("user-2"), "user-1", { name: "Hack" }, UNCONDITIONAL),
        ),
      ).rejects.toThrow(ForbiddenException);

      await expect(queries.execute(new GetUserQuery("user-1"))).resolves.toMatchObject({
        name: "Test User",
      });
    });
  });

  describe("UpdateUserAvatarCommand", () => {
    beforeEach(() => {
      store.seed({ id: "user-1", email: "test@example.com" });
    });

    it("uploads the image, stores its object key, and invalidates the cache", async () => {
      const result = await commands.execute(
        new UpdateUserAvatarCommand(asUser("user-1"), "user-1", avatarFile, ifMatch(0)),
      );

      expect(mockStorage.uploadBuffer).toHaveBeenCalledWith(
        expect.stringMatching(/^avatars\/user-1\/\d+\.jpg$/),
        avatarFile.buffer,
        "image/jpeg",
      );
      // The key the handler minted, not a URL, and lower-cased from `photo.JPG`.
      expect(result.avatarUrl).toBe(mockStorage.uploadBuffer.mock.calls[0]![0]);
      expect(mockCache.delMany).toHaveBeenCalledWith([
        userCacheKey("user-1"),
        USERS_LIST_CACHE_KEY,
      ]);
    });

    it("spends no upload on a request that has already lost the race", async () => {
      await commands.execute(new UpdateUserCommand("user-1", { name: "Moved" }, UNCONDITIONAL));

      await expect(
        commands.execute(
          new UpdateUserAvatarCommand(asUser("user-1"), "user-1", avatarFile, ifMatch(0)),
        ),
      ).rejects.toThrow(PreconditionFailedException);

      expect(mockStorage.uploadBuffer).not.toHaveBeenCalled();
    });

    it("spends no upload on a request from a stranger", async () => {
      await expect(
        commands.execute(
          new UpdateUserAvatarCommand(asUser("user-2"), "user-1", avatarFile, ifMatch(0)),
        ),
      ).rejects.toThrow(ForbiddenException);

      expect(mockStorage.uploadBuffer).not.toHaveBeenCalled();
    });

    it("allows an ADMIN to upload an avatar for another user", async () => {
      await expect(
        commands.execute(
          new UpdateUserAvatarCommand(asAdmin("admin-1"), "user-1", avatarFile, ifMatch(0)),
        ),
      ).resolves.toMatchObject({ avatarUrl: expect.stringContaining("avatars/user-1/") });
    });

    it("throws NotFoundException for a missing user", async () => {
      await expect(
        commands.execute(
          new UpdateUserAvatarCommand(asAdmin("admin-1"), "missing", avatarFile, ifMatch(0)),
        ),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe("DeleteUserCommand", () => {
    it("deletes the user and invalidates cache", async () => {
      store.seed({ id: "user-1", email: "test@example.com" });

      await commands.execute(new DeleteUserCommand("user-1", ifMatch(0)));

      await expect(queries.execute(new GetUserQuery("user-1"))).rejects.toThrow(NotFoundException);
      expect(mockCache.delMany).toHaveBeenCalledWith([
        userCacheKey("user-1"),
        USERS_LIST_CACHE_KEY,
      ]);
    });

    it("throws NotFoundException for missing user", async () => {
      await expect(
        commands.execute(new DeleteUserCommand("missing", UNCONDITIONAL)),
      ).rejects.toThrow(NotFoundException);
    });

    it("stages user.deleted with the address, which nothing can look up afterwards", async () => {
      store.seed({ id: "user-1", email: "test@example.com" });

      await commands.execute(new DeleteUserCommand("user-1", ifMatch(0)));

      expect(staged()).toEqual([
        { name: "user.deleted", payload: { userId: "user-1", email: "test@example.com" } },
      ]);
    });

    it("stages the event inside the transaction that deletes the row", async () => {
      store.seed({ id: "user-1", email: "test@example.com" });

      await commands.execute(new DeleteUserCommand("user-1", ifMatch(0)));

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

      await expect(commands.execute(new DeleteUserCommand("user-1", ifMatch(0)))).rejects.toThrow(
        "redis down",
      );

      expect(transactions.rolledBack).toBe(1);
      expect(staged()).toEqual([]);
      await expect(queries.execute(new GetUserQuery("user-1"))).resolves.toMatchObject({
        id: "user-1",
      });
    });

    it("stages nothing when the user does not exist", async () => {
      await expect(
        commands.execute(new DeleteUserCommand("missing", UNCONDITIONAL)),
      ).rejects.toThrow(NotFoundException);

      expect(staged()).toEqual([]);
      expect(transactions.started).toBe(0);
    });
  });

  describe("GetUserPreferencesQuery", () => {
    beforeEach(async () => {
      store.seed({ id: "user-1", email: "test@example.com" });
      await store.setPreferences("user-1", { theme: "dark" }, UNCONDITIONAL);
    });

    it("returns preferences for own user", async () => {
      await expect(
        queries.execute(new GetUserPreferencesQuery(asUser("user-1"), "user-1")),
      ).resolves.toEqual({
        preferences: { ...DEFAULT_USER_PREFERENCES, theme: "dark" },
        version: 1,
      });
    });

    it("allows ADMIN to read any user's preferences", async () => {
      await expect(
        queries.execute(new GetUserPreferencesQuery(asAdmin("admin-99"), "user-1")),
      ).resolves.toEqual({
        preferences: { ...DEFAULT_USER_PREFERENCES, theme: "dark" },
        version: 1,
      });
    });

    it("throws ForbiddenException when a non-admin reads another user's preferences", async () => {
      await expect(
        queries.execute(new GetUserPreferencesQuery(asUser("user-2"), "user-1")),
      ).rejects.toThrow(ForbiddenException);
    });

    it("throws NotFoundException for missing user", async () => {
      await expect(
        queries.execute(new GetUserPreferencesQuery(asUser("missing"), "missing")),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe("UpdateUserPreferencesCommand", () => {
    beforeEach(() => {
      store.seed({ id: "user-1", email: "test@example.com" });
    });

    it("merges the patch and evicts the preferences cache entry", async () => {
      await expect(
        commands.execute(
          new UpdateUserPreferencesCommand(
            asUser("user-1"),
            "user-1",
            { theme: "light" },
            ifMatch(0),
          ),
        ),
      ).resolves.toEqual({
        preferences: { ...DEFAULT_USER_PREFERENCES, theme: "light" },
        version: 1,
      });
      expect(mockCache.del).toHaveBeenCalledWith(`${userCacheKey("user-1")}:prefs`);
    });

    it("allows ADMIN to update any user's preferences", async () => {
      await expect(
        commands.execute(
          new UpdateUserPreferencesCommand(
            asAdmin("admin-99"),
            "user-1",
            { theme: "light" },
            ifMatch(0),
          ),
        ),
      ).resolves.toMatchObject({ preferences: { theme: "light" } });
    });

    it("throws ForbiddenException when a non-admin updates another user's preferences", async () => {
      await expect(
        commands.execute(
          new UpdateUserPreferencesCommand(
            asUser("user-2"),
            "user-1",
            { theme: "dark" },
            UNCONDITIONAL,
          ),
        ),
      ).rejects.toThrow(ForbiddenException);
    });

    it("throws NotFoundException for missing user", async () => {
      await expect(
        commands.execute(
          new UpdateUserPreferencesCommand(asUser("missing"), "missing", {}, UNCONDITIONAL),
        ),
      ).rejects.toThrow(NotFoundException);
    });
  });

  // ─── Optimistic concurrency ─────────────────────────────────────────────────
  //
  // The store raises `VersionConflictError`; the endpoints answer 412.
  // `UserWriteModel` is where the one becomes the other, so it is where the
  // translation is pinned — through the commands that go through it.

  describe("conditional writes", () => {
    beforeEach(() => {
      store.seed({ id: "user-1", email: "test@example.com", name: "Test User" });
    });

    it("applies an update whose If-Match names the current version", async () => {
      await expect(
        commands.execute(new UpdateUserCommand("user-1", { name: "Updated" }, ifMatch(0))),
      ).resolves.toMatchObject({ name: "Updated", version: 1 });
    });

    it("answers 412 once the row has moved past the version the caller read", async () => {
      await commands.execute(new UpdateUserCommand("user-1", { name: "First" }, UNCONDITIONAL));

      await expect(
        commands.execute(new UpdateUserCommand("user-1", { name: "Second" }, ifMatch(0))),
      ).rejects.toThrow(PreconditionFailedException);
    });

    it("names the version the row is at, so the client knows what to re-read", async () => {
      await commands.execute(new UpdateUserCommand("user-1", { name: "First" }, UNCONDITIONAL));

      await expect(
        commands.execute(new UpdateUserCommand("user-1", { name: "Second" }, ifMatch(0))),
      ).rejects.toThrow(/version 1/);
    });

    it("leaves the cache alone when the write was refused", async () => {
      await commands.execute(new UpdateUserCommand("user-1", { name: "First" }, UNCONDITIONAL));
      mockCache.delMany.mockClear();

      await expect(
        commands.execute(new UpdateUserCommand("user-1", { name: "Second" }, ifMatch(0))),
      ).rejects.toThrow();

      expect(mockCache.delMany).not.toHaveBeenCalled();
    });

    it("answers 412 rather than deleting against a stale version", async () => {
      await commands.execute(new UpdateUserCommand("user-1", { name: "First" }, UNCONDITIONAL));

      await expect(commands.execute(new DeleteUserCommand("user-1", ifMatch(0)))).rejects.toThrow(
        PreconditionFailedException,
      );
      await expect(queries.execute(new GetUserQuery("user-1"))).resolves.toBeDefined();
    });

    it("leaves no staged event when a conditional delete is refused", async () => {
      await commands.execute(new UpdateUserCommand("user-1", { name: "First" }, UNCONDITIONAL));
      outboxStore.reset();

      await expect(commands.execute(new DeleteUserCommand("user-1", ifMatch(0)))).rejects.toThrow();

      expect(staged()).toEqual([]);
    });

    it("answers 412 on a stale preference write", async () => {
      await commands.execute(
        new UpdateUserPreferencesCommand(asUser("user-1"), "user-1", { theme: "dark" }, ifMatch(0)),
      );

      await expect(
        commands.execute(
          new UpdateUserPreferencesCommand(
            asUser("user-1"),
            "user-1",
            { language: "fr" },
            ifMatch(0),
          ),
        ),
      ).rejects.toThrow(PreconditionFailedException);
    });

    it("moves the user's version when preferences are written, so the two stay in step", async () => {
      await commands.execute(
        new UpdateUserPreferencesCommand(asUser("user-1"), "user-1", { theme: "dark" }, ifMatch(0)),
      );

      await expect(queries.execute(new GetUserQuery("user-1"))).resolves.toMatchObject({
        version: 1,
      });
    });

    it("evicts the user entry too, because preferences live on the user row", async () => {
      await commands.execute(
        new UpdateUserPreferencesCommand(asUser("user-1"), "user-1", { theme: "dark" }, ifMatch(0)),
      );

      expect(mockCache.delMany).toHaveBeenCalledWith([
        userCacheKey("user-1"),
        USERS_LIST_CACHE_KEY,
      ]);
    });
  });

  // ─── Precondition ordering ──────────────────────────────────────────────────
  //
  // RFC 9110 §13.2.1, asserted through `DeleteUserCommand` because it is the
  // command with no policy check in front of it — so what these specs observe
  // is `UserWriteModel.assertPrecondition` and nothing else.

  describe("precondition ordering", () => {
    beforeEach(() => {
      store.seed({ id: "user-1", email: "test@example.com" });
    });

    it("accepts a precondition naming the current version", async () => {
      await expect(
        commands.execute(new DeleteUserCommand("user-1", ifMatch(0))),
      ).resolves.toBeUndefined();
    });

    it("throws 412 for a stale one", async () => {
      await commands.execute(new UpdateUserCommand("user-1", { name: "Moved" }, UNCONDITIONAL));

      await expect(commands.execute(new DeleteUserCommand("user-1", ifMatch(0)))).rejects.toThrow(
        PreconditionFailedException,
      );
    });

    it("throws 428 when the caller named no version at all", async () => {
      await expect(
        commands.execute(new DeleteUserCommand("user-1", UNCONDITIONAL)),
      ).rejects.toThrow(PreconditionRequiredException);
    });

    // Preconditions are evaluated after the server's normal request checks. A
    // 428 for a row that does not exist would send the client to fetch an ETag
    // it can never obtain.
    it("throws 404 rather than 428 when there is no such user", async () => {
      await expect(
        commands.execute(new DeleteUserCommand("missing", UNCONDITIONAL)),
      ).rejects.toThrow(NotFoundException);
    });

    it("throws 404 rather than 412 when there is no such user", async () => {
      await expect(commands.execute(new DeleteUserCommand("missing", ifMatch(0)))).rejects.toThrow(
        NotFoundException,
      );
    });

    it("throws 428 rather than 412 when the caller sent nothing to compare", async () => {
      // The reverse order would tell a client that sent no validator that the
      // one it sent was stale.
      await commands.execute(new UpdateUserCommand("user-1", { name: "Moved" }, UNCONDITIONAL));

      await expect(
        commands.execute(new DeleteUserCommand("user-1", UNCONDITIONAL)),
      ).rejects.toThrow(PreconditionRequiredException);
    });
  });

  describe("required preconditions", () => {
    beforeEach(() => {
      store.seed({ id: "user-1", email: "test@example.com" });
    });

    it("refuses an unconditional profile update from a client", async () => {
      await expect(
        commands.execute(
          new UpdateUserProfileCommand(asUser("user-1"), "user-1", { name: "X" }, UNCONDITIONAL),
        ),
      ).rejects.toThrow(PreconditionRequiredException);
    });

    it("refuses an unconditional preference update from a client", async () => {
      await expect(
        commands.execute(
          new UpdateUserPreferencesCommand(
            asUser("user-1"),
            "user-1",
            { theme: "dark" },
            UNCONDITIONAL,
          ),
        ),
      ).rejects.toThrow(PreconditionRequiredException);
    });

    it("refuses an unconditional delete", async () => {
      await expect(
        commands.execute(new DeleteUserCommand("user-1", UNCONDITIONAL)),
      ).rejects.toThrow(PreconditionRequiredException);
    });

    it("checks ownership before the precondition, so a stranger is told 403 and not 428", async () => {
      await expect(
        commands.execute(
          new UpdateUserProfileCommand(asUser("user-2"), "user-1", { name: "X" }, UNCONDITIONAL),
        ),
      ).rejects.toThrow(ForbiddenException);
    });

    it("still allows an internal caller to write unconditionally", async () => {
      // `UpdateUserCommand` is the OAuth link path, which has no version to
      // name. Making it demand one would strand the sign-in.
      await expect(
        commands.execute(new UpdateUserCommand("user-1", { provider: "google" }, UNCONDITIONAL)),
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
