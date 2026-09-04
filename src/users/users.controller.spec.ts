import { Test, TestingModule } from "@nestjs/testing";
import { BadRequestException } from "@nestjs/common";
import { CACHE_MANAGER } from "@nestjs/cache-manager";
import { CommandBus, QueryBus } from "@nestjs/cqrs";
import { UsersController } from "./users.controller";
import { GetUserPreferencesQuery, GetUserQuery, ListUsersQuery } from "./read";
import {
  DeleteUserCommand,
  UpdateUserAvatarCommand,
  UpdateUserPreferencesCommand,
  UpdateUserProfileCommand,
} from "./write";
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

const mockCommandBus = { execute: jest.fn() };
const mockQueryBus = { execute: jest.fn() };

// The controller is decorated with HttpCacheInterceptor, which Nest instantiates
// while building the testing module — so CACHE_MANAGER has to be resolvable here.
const mockCacheManager = {
  get: jest.fn(),
  set: jest.fn(),
  del: jest.fn(),
  mdel: jest.fn(),
  clear: jest.fn(),
};

/**
 * What the controller is still responsible for, now that the handlers own the
 * decisions.
 *
 * Every endpoint has exactly one job left: build the right request from the
 * HTTP input and shape what comes back. So that is what these specs assert —
 * the *command object* that was dispatched, not the effect of running it, which
 * `users.cqrs.spec.ts` covers against the real handlers. Asserting on the
 * dispatched request is what catches the mistake this layer can actually make:
 * an argument in the wrong position, a requester dropped, an `If-Match` used
 * for the pre-check and then not passed to the write.
 */
describe("UsersController", () => {
  let controller: UsersController;

  beforeEach(async () => {
    jest.resetAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      controllers: [UsersController],
      providers: [
        { provide: CommandBus, useValue: mockCommandBus },
        { provide: QueryBus, useValue: mockQueryBus },
        { provide: CACHE_MANAGER, useValue: mockCacheManager },
      ],
    }).compile();

    controller = module.get(UsersController);
  });

  /** The single request dispatched onto a bus during one endpoint call. */
  function dispatched(bus: { execute: jest.Mock }): unknown {
    expect(bus.execute).toHaveBeenCalledTimes(1);
    return bus.execute.mock.calls[0]![0];
  }

  it("should be defined", () => {
    expect(controller).toBeDefined();
  });

  describe("listUsers()", () => {
    it("dispatches ListUsersQuery carrying the parsed query string", async () => {
      const page = { items: [mockUser], hasNextPage: false, nextCursor: null };
      mockQueryBus.execute.mockResolvedValue(page);
      const query = { limit: 20, search: "ada" };

      const result = await controller.listUsers(query as never);

      expect(dispatched(mockQueryBus)).toEqual(new ListUsersQuery(query as never));
      expect(result).toBe(page);
    });
  });

  describe("findOne()", () => {
    it("dispatches GetUserQuery and wraps the answer with its version", async () => {
      mockQueryBus.execute.mockResolvedValue(mockUser);

      const result = await controller.findOne("user-1");

      expect(dispatched(mockQueryBus)).toEqual(new GetUserQuery("user-1"));
      expect(result).toEqual(versioned(mockUser, 0));
    });
  });

  describe("update()", () => {
    it("dispatches UpdateUserProfileCommand with the requester and the precondition", async () => {
      const updated = { ...mockUser, name: "New Name" };
      mockCommandBus.execute.mockResolvedValue(updated);
      const dto = { name: "New Name" };

      const result = await controller.update("user-1", dto, requester, ifMatch(0));

      expect(dispatched(mockCommandBus)).toEqual(
        new UpdateUserProfileCommand(requester, "user-1", dto, ifMatch(0)),
      );
      expect(result).toEqual(versioned(updated, updated.version));
    });

    it("wraps the result so the response carries the version it wrote", async () => {
      mockCommandBus.execute.mockResolvedValue({ ...mockUser, version: 4 });

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

    it("dispatches UpdateUserAvatarCommand carrying the uploaded file", async () => {
      mockCommandBus.execute.mockResolvedValue({ ...mockUser, avatarUrl: "avatars/user-1/1.jpg" });

      const result = await controller.uploadAvatar("user-1", file, requester, ifMatch(2));

      // Including the `If-Match`: the handler checks the precondition before it
      // uploads *and* passes it to the write, and a controller that dropped it
      // here would turn every avatar upload into an unconditional write.
      expect(dispatched(mockCommandBus)).toEqual(
        new UpdateUserAvatarCommand(requester, "user-1", file, ifMatch(2)),
      );
      expect(result).toMatchObject({ body: { avatarUrl: "avatars/user-1/1.jpg" } });
    });

    it("throws BadRequestException when no file is provided", async () => {
      await expect(
        controller.uploadAvatar("user-1", undefined, requester, ifMatch(0)),
      ).rejects.toThrow(BadRequestException);

      // Nothing is dispatched: a multipart body with no `file` part is a
      // malformed request, not a write that fails somewhere downstream.
      expect(mockCommandBus.execute).not.toHaveBeenCalled();
    });
  });

  describe("remove()", () => {
    it("dispatches DeleteUserCommand with the precondition", async () => {
      mockCommandBus.execute.mockResolvedValue(undefined);

      await controller.remove("user-1", ifMatch(0));

      expect(dispatched(mockCommandBus)).toEqual(new DeleteUserCommand("user-1", ifMatch(0)));
    });
  });

  describe("getPreferences()", () => {
    it("dispatches GetUserPreferencesQuery with the requester", async () => {
      const prefs = {
        theme: "dark",
        language: "en",
        emailNotifications: true,
        pushNotifications: false,
        timezone: "UTC",
      };
      mockQueryBus.execute.mockResolvedValue({ preferences: prefs, version: 2 });

      const result = await controller.getPreferences("user-1", requester);

      expect(dispatched(mockQueryBus)).toEqual(new GetUserPreferencesQuery(requester, "user-1"));
      // The version comes back on the wrapper, not in the body: preferences are
      // a projection of the user row and have no version field of their own.
      expect(result).toEqual(versioned(prefs, 2));
    });
  });

  describe("updatePreferences()", () => {
    it("dispatches UpdateUserPreferencesCommand with the requester", async () => {
      const prefs = {
        theme: "light",
        language: "fr",
        emailNotifications: false,
        pushNotifications: true,
        timezone: "UTC",
      };
      mockCommandBus.execute.mockResolvedValue({ preferences: prefs, version: 3 });
      const dto = { theme: "light" as const };

      const result = await controller.updatePreferences(
        "user-1",
        dto as never,
        requester,
        ifMatch(2),
      );

      expect(dispatched(mockCommandBus)).toEqual(
        new UpdateUserPreferencesCommand(requester, "user-1", dto as never, ifMatch(2)),
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
