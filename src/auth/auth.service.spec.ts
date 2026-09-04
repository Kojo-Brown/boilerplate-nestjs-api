import { Test, TestingModule } from "@nestjs/testing";
import { JwtService } from "@nestjs/jwt";
import { ConfigService } from "@nestjs/config";
import { ConflictException, UnauthorizedException } from "@nestjs/common";
import { Role } from "@prisma/client";
import { CommandBus, QueryBus } from "@nestjs/cqrs";
import { AuthService } from "./auth.service";
import { CreateUserCommand, UpdateUserCommand } from "@/users/write";
import { FindUserByEmailQuery, FindUserByProviderAccountQuery } from "@/users/read";
import { REFRESH_TOKEN_STORE } from "./ports";
import { TRANSACTION_RUNNER } from "@/common/prisma/transaction.port";
import { OUTBOX_STORE, TransactionalOutbox } from "@/outbox";
import { EventContract } from "@/schema-registry";
import { realEventContract } from "@/test-utils/event-contract";
import { InMemoryOutboxStore } from "@/test-utils/in-memory-outbox.store";
import { InMemoryTransactionRunner } from "@/test-utils/in-memory-transaction.runner";
import { UNCONDITIONAL } from "@/common/concurrency";
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
  providerAccountId: null,
  avatarUrl: null,
  preferences: null,
  createdAt: new Date("2024-01-01"),
  updatedAt: new Date("2024-01-01"),
  version: 0,
};

/**
 * The users module, as the four requests `AuthService` now dispatches.
 *
 * The buses below route by command and query class rather than stubbing
 * `execute` once, and that is what keeps every assertion in this file an
 * assertion about *which request was made, with what*. A single `execute` spy
 * would flatten a registration, a link and two lookups into one call log, so
 * "created the user with the hashed password" and "did not create one" would
 * both read as "called execute".
 *
 * Routing also fails loudly on a request nothing here knows about, which is the
 * check a bus needs most: a typo'd command class is otherwise a resolved
 * promise of `undefined` rather than a missing handler.
 */
const usersModule = {
  findByEmail: jest.fn(),
  create: jest.fn(),
  update: jest.fn(),
  findByProviderAccount: jest.fn(),
};

const mockCommandBus = { execute: jest.fn() };
const mockQueryBus = { execute: jest.fn() };

/** Re-applied after `resetAllMocks`, which drops implementations as well as calls. */
function routeBusesToUsersModule(): void {
  mockCommandBus.execute.mockImplementation((command: unknown) => {
    if (command instanceof CreateUserCommand) return usersModule.create(command.data, command.tx);
    if (command instanceof UpdateUserCommand) {
      return usersModule.update(command.id, command.data, command.expected);
    }
    throw new Error(`No handler for ${describeRequest(command)}`);
  });
  mockQueryBus.execute.mockImplementation((query: unknown) => {
    if (query instanceof FindUserByEmailQuery) return usersModule.findByEmail(query.email);
    if (query instanceof FindUserByProviderAccountQuery) {
      return usersModule.findByProviderAccount(query.provider, query.providerAccountId);
    }
    throw new Error(`No handler for ${describeRequest(query)}`);
  });
}

function describeRequest(request: unknown): string {
  return typeof request === "object" && request !== null
    ? request.constructor.name
    : String(request);
}

const mockJwtService = {
  sign: jest.fn(),
};

/**
 * The real `TransactionalOutbox` over an in-memory store, rather than a spy.
 *
 * What matters here is that registration announces itself with the right
 * payload *and* that the announcement is part of the same unit of work as the
 * insert — and the second half is not something a spy on a bus can show. The
 * store leaves rows behind, so the assertion is what was written; `src/outbox`
 * covers delivery from there.
 */
let outboxStore: InMemoryOutboxStore;
let transactions: InMemoryTransactionRunner;

const staged = () => outboxStore.all().map((row) => ({ name: row.name, payload: row.payload }));

const mockConfigService = {
  get: jest.fn(),
  getOrThrow: jest.fn(),
};

/**
 * A double for the refresh-token store.
 *
 * `consume` is what rotation now goes through, and its atomicity is asserted
 * against real implementations by `refresh-token-store.contract.ts` — this file
 * covers what `AuthService` does with the answer, not how the answer is
 * reached.
 */
const mockRefreshTokens = {
  issue: jest.fn(),
  consume: jest.fn(),
  revoke: jest.fn(),
};

describe("AuthService", () => {
  let service: AuthService;

  beforeEach(async () => {
    jest.resetAllMocks();
    routeBusesToUsersModule();
    mockJwtService.sign.mockReturnValue("mock-access-token");
    mockConfigService.get.mockReturnValue("7d");
    mockConfigService.getOrThrow.mockReturnValue("test-secret");

    outboxStore = new InMemoryOutboxStore();
    transactions = new InMemoryTransactionRunner();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        TransactionalOutbox,
        // The real contract over the real catalogue: staging now checks the
        // payload against its schema, and a permissive stub here would stop
        // these suites noticing an event they emit that no consumer can read.
        { provide: EventContract, useFactory: realEventContract },
        { provide: CommandBus, useValue: mockCommandBus },
        { provide: QueryBus, useValue: mockQueryBus },
        { provide: JwtService, useValue: mockJwtService },
        { provide: ConfigService, useValue: mockConfigService },
        { provide: REFRESH_TOKEN_STORE, useValue: mockRefreshTokens },
        { provide: OUTBOX_STORE, useValue: outboxStore },
        { provide: TRANSACTION_RUNNER, useValue: transactions },
      ],
    }).compile();

    service = module.get<AuthService>(AuthService);
  });

  describe("register", () => {
    it("throws ConflictException when email already in use", async () => {
      usersModule.findByEmail.mockResolvedValue(mockUser);

      await expect(
        service.register({ email: "test@example.com", password: "password123" }),
      ).rejects.toThrow(ConflictException);

      expect(usersModule.create).not.toHaveBeenCalled();
    });

    it("hashes password, creates user, and returns tokens", async () => {
      usersModule.findByEmail.mockResolvedValue(null);
      argon2.hash.mockResolvedValue("hashed-password");
      usersModule.create.mockResolvedValue(mockUser);
      mockRefreshTokens.issue.mockResolvedValue(undefined);

      const result = await service.register({ email: "test@example.com", password: "password123" });

      expect(argon2.hash).toHaveBeenCalledWith("password123");
      expect(usersModule.create).toHaveBeenCalledWith(
        expect.objectContaining({ email: "test@example.com", password: "hashed-password" }),
        // The unit of work the event is staged in. Asserted properly in
        // "writes the row and the event in one unit of work" below.
        expect.anything(),
      );
      expect(result).toMatchObject({ accessToken: "mock-access-token", expiresIn: 900 });
      expect(typeof result.refreshToken).toBe("string");
    });

    it("announces user.registered so subscribers need no reference to auth", async () => {
      usersModule.findByEmail.mockResolvedValue(null);
      argon2.hash.mockResolvedValue("hashed-password");
      usersModule.create.mockResolvedValue(mockUser);
      mockRefreshTokens.issue.mockResolvedValue(undefined);

      await service.register({ email: "test@example.com", password: "password123" });

      expect(staged()).toEqual([
        {
          name: "user.registered",
          payload: {
            userId: mockUser.id,
            email: mockUser.email,
            name: mockUser.name,
            provider: null,
          },
        },
      ]);
    });

    it("writes the row and the event in one unit of work", async () => {
      usersModule.findByEmail.mockResolvedValue(null);
      argon2.hash.mockResolvedValue("hashed-password");
      usersModule.create.mockResolvedValue(mockUser);
      mockRefreshTokens.issue.mockResolvedValue(undefined);

      await service.register({ email: "test@example.com", password: "password123" });

      expect(transactions.started).toBe(1);
      expect(transactions.committed).toBe(1);
      // The insert is enrolled in it — a `create` called without the handle
      // would run on its own connection and commit independently of the event.
      expect(usersModule.create).toHaveBeenCalledWith(
        expect.objectContaining({ email: "test@example.com" }),
        expect.objectContaining({ backend: "in-memory" }),
      );
    });

    it("hashes the password outside the transaction", async () => {
      const order: string[] = [];
      usersModule.findByEmail.mockResolvedValue(null);
      argon2.hash.mockImplementation(() => {
        order.push("hash");
        return Promise.resolve("hashed-password");
      });
      usersModule.create.mockImplementation(() => {
        order.push("create");
        return Promise.resolve(mockUser);
      });
      mockRefreshTokens.issue.mockResolvedValue(undefined);

      await service.register({ email: "test@example.com", password: "password123" });

      // argon2 is deliberately slow. Holding a connection and the transaction's
      // locks for the length of a KDF would make every registration a
      // multi-hundred-millisecond writer.
      expect(order).toEqual(["hash", "create"]);
      expect(transactions.started).toBe(1);
    });

    it("stages nothing, and opens no transaction, when the email is already taken", async () => {
      usersModule.findByEmail.mockResolvedValue(mockUser);

      await expect(
        service.register({ email: "test@example.com", password: "password123" }),
      ).rejects.toThrow(ConflictException);

      expect(staged()).toEqual([]);
      expect(transactions.started).toBe(0);
    });

    it("discards the event when the unit of work fails", async () => {
      usersModule.findByEmail.mockResolvedValue(null);
      argon2.hash.mockResolvedValue("hashed-password");
      usersModule.create.mockRejectedValue(new Error("unique violation"));

      await expect(
        service.register({ email: "test@example.com", password: "password123" }),
      ).rejects.toThrow("unique violation");

      expect(staged()).toEqual([]);
      expect(transactions.rolledBack).toBe(1);
    });
  });

  describe("login", () => {
    it("throws UnauthorizedException when user not found", async () => {
      usersModule.findByEmail.mockResolvedValue(null);

      await expect(
        service.login({ email: "unknown@example.com", password: "password123" }),
      ).rejects.toThrow(UnauthorizedException);
    });

    it("throws UnauthorizedException when password is wrong", async () => {
      usersModule.findByEmail.mockResolvedValue(mockUser);
      argon2.verify.mockResolvedValue(false);

      await expect(service.login({ email: "test@example.com", password: "wrong" })).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it("returns tokens on valid credentials", async () => {
      usersModule.findByEmail.mockResolvedValue(mockUser);
      argon2.verify.mockResolvedValue(true);
      mockRefreshTokens.issue.mockResolvedValue(undefined);

      const result = await service.login({ email: "test@example.com", password: "password123" });

      expect(result).toMatchObject({ accessToken: "mock-access-token", expiresIn: 900 });
      expect(typeof result.refreshToken).toBe("string");
    });
  });

  describe("refresh", () => {
    it("throws UnauthorizedException when the token could not be claimed", async () => {
      mockRefreshTokens.consume.mockResolvedValue(null);

      await expect(service.refresh("bad-token")).rejects.toThrow(UnauthorizedException);
    });

    it("issues nothing when the claim came back empty", async () => {
      // A rejected refresh must not mint a replacement — the losing side of a
      // rotation race lands here, and handing it a token family would be the
      // exact bug `consume` exists to prevent.
      mockRefreshTokens.consume.mockResolvedValue(null);

      await expect(service.refresh("bad-token")).rejects.toThrow(UnauthorizedException);
      expect(mockRefreshTokens.issue).not.toHaveBeenCalled();
    });

    it("throws UnauthorizedException for an expired token", async () => {
      mockRefreshTokens.consume.mockResolvedValue({
        userId: "user-1",
        email: mockUser.email,
        role: Role.USER,
        expiresAt: new Date(Date.now() - 1_000),
      });

      await expect(service.refresh("expired")).rejects.toThrow(UnauthorizedException);
      expect(mockRefreshTokens.issue).not.toHaveBeenCalled();
    });

    it("claims the presented token and issues a new one (rotation)", async () => {
      mockRefreshTokens.consume.mockResolvedValue({
        userId: "user-1",
        email: mockUser.email,
        role: Role.USER,
        expiresAt: new Date(Date.now() + 86_400_000),
      });

      const result = await service.refresh("valid-token");

      expect(mockRefreshTokens.consume).toHaveBeenCalledWith("valid-token");
      expect(result).toMatchObject({ accessToken: "mock-access-token", expiresIn: 900 });
      expect(mockRefreshTokens.issue).toHaveBeenCalledWith(
        expect.objectContaining({ userId: "user-1", token: result.refreshToken }),
      );
    });

    it("issues a token that is not the one just spent", async () => {
      mockRefreshTokens.consume.mockResolvedValue({
        userId: "user-1",
        email: mockUser.email,
        role: Role.USER,
        expiresAt: new Date(Date.now() + 86_400_000),
      });

      const result = await service.refresh("valid-token");

      expect(result.refreshToken).not.toBe("valid-token");
    });
  });

  describe("logout", () => {
    it("revokes the refresh token", async () => {
      mockRefreshTokens.revoke.mockResolvedValue(undefined);

      await service.logout("my-token");

      expect(mockRefreshTokens.revoke).toHaveBeenCalledWith("my-token");
    });
  });

  describe("loginWithGoogle", () => {
    const googleProfile = { googleId: "g-123", email: "google@example.com", name: "Google User" };

    it("creates a new user when no account exists for the Google ID or email", async () => {
      usersModule.findByProviderAccount.mockResolvedValue(null);
      usersModule.findByEmail.mockResolvedValue(null);
      usersModule.create.mockResolvedValue({
        ...mockUser,
        email: googleProfile.email,
        provider: "google",
      });
      mockRefreshTokens.issue.mockResolvedValue(undefined);

      const result = await service.loginWithGoogle(googleProfile);

      expect(usersModule.create).toHaveBeenCalledWith(
        expect.objectContaining({
          email: googleProfile.email,
          provider: "google",
          providerAccountId: "g-123",
        }),
        expect.anything(),
      );
      expect(result).toMatchObject({ accessToken: "mock-access-token", expiresIn: 900 });
      expect(staged()).toEqual([
        {
          name: "user.registered",
          payload: expect.objectContaining({ email: googleProfile.email, provider: "google" }),
        },
      ]);
    });

    it("links Google account to an existing user found by email", async () => {
      usersModule.findByProviderAccount.mockResolvedValue(null);
      usersModule.findByEmail.mockResolvedValue(mockUser);
      usersModule.update.mockResolvedValue({
        ...mockUser,
        provider: "google",
        providerAccountId: "g-123",
      });
      mockRefreshTokens.issue.mockResolvedValue(undefined);

      const result = await service.loginWithGoogle(googleProfile);

      expect(usersModule.update).toHaveBeenCalledWith(
        mockUser.id,
        expect.objectContaining({ provider: "google", providerAccountId: "g-123" }),
        // Unconditional: the OAuth callback is not a client proposing an edit
        // to a representation it read, so there is no version it could name.
        UNCONDITIONAL,
      );
      expect(result).toMatchObject({ accessToken: "mock-access-token", expiresIn: 900 });
      // Linking is not a registration: this account has been welcomed already.
      expect(staged()).toEqual([]);
    });

    it("returns tokens for an existing user matched by Google provider account ID", async () => {
      const googleUser = { ...mockUser, provider: "google", providerAccountId: "g-123" };
      usersModule.findByProviderAccount.mockResolvedValue(googleUser);
      mockRefreshTokens.issue.mockResolvedValue(undefined);

      const result = await service.loginWithGoogle(googleProfile);

      expect(usersModule.findByEmail).not.toHaveBeenCalled();
      expect(usersModule.create).not.toHaveBeenCalled();
      expect(result).toMatchObject({ accessToken: "mock-access-token", expiresIn: 900 });
      expect(staged()).toEqual([]);
    });
  });
});
