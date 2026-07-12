import { Role } from "@prisma/client";
import type { User, RefreshToken } from "@prisma/client";
import {
  buildUser,
  buildAdminUser,
  buildOAuthUser,
  createUser,
  createAdminUser,
  buildRefreshToken,
  buildExpiredRefreshToken,
  createRefreshToken,
} from "./index";

function makeMockUserCreate(result?: Partial<User>) {
  return jest.fn().mockImplementation(async ({ data }: { data: Partial<User> & { email: string } }) => ({
    id: "mock-id",
    name: null,
    password: null,
    role: Role.USER,
    provider: null,
    providerAccountId: null,
    avatarUrl: null,
    preferences: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...data,
    ...result,
  }));
}

function makeMockRefreshTokenCreate(result?: Partial<RefreshToken>) {
  return jest.fn().mockImplementation(async ({ data }: { data: { token: string; userId: string; expiresAt: Date } }) => ({
    id: "mock-rt-id",
    createdAt: new Date(),
    ...data,
    ...result,
  }));
}

describe("UserFactory", () => {
  describe("buildUser", () => {
    it("returns a fully-typed User with faker-generated fields", () => {
      const user = buildUser();

      expect(typeof user.id).toBe("string");
      expect(user.id.length).toBeGreaterThan(0);
      expect(typeof user.email).toBe("string");
      expect(user.email).toContain("@");
      expect(typeof user.name).toBe("string");
      expect(user.role).toBe(Role.USER);
      expect(user.provider).toBeNull();
      expect(user.providerAccountId).toBeNull();
      expect(user.avatarUrl).toBeNull();
      expect(user.preferences).toBeNull();
      expect(user.createdAt).toBeInstanceOf(Date);
      expect(user.updatedAt).toBeInstanceOf(Date);
    });

    it("applies overrides over defaults", () => {
      const override = {
        email: "override@example.com",
        name: "Override Name",
        role: Role.ADMIN,
      };
      const user = buildUser(override);

      expect(user.email).toBe("override@example.com");
      expect(user.name).toBe("Override Name");
      expect(user.role).toBe(Role.ADMIN);
    });

    it("generates unique ids on each call", () => {
      const ids = new Set(Array.from({ length: 20 }, () => buildUser().id));
      expect(ids.size).toBe(20);
    });

    it("generates unique emails on each call", () => {
      const emails = new Set(Array.from({ length: 10 }, () => buildUser().email));
      expect(emails.size).toBeGreaterThan(1);
    });
  });

  describe("buildAdminUser", () => {
    it("returns a User with ADMIN role", () => {
      const user = buildAdminUser();
      expect(user.role).toBe(Role.ADMIN);
    });

    it("still applies additional overrides", () => {
      const user = buildAdminUser({ name: "Super Admin" });
      expect(user.role).toBe(Role.ADMIN);
      expect(user.name).toBe("Super Admin");
    });
  });

  describe("buildOAuthUser", () => {
    it("returns a User with the given provider and no password", () => {
      const user = buildOAuthUser("google");

      expect(user.provider).toBe("google");
      expect(user.providerAccountId).not.toBeNull();
      expect(typeof user.providerAccountId).toBe("string");
      expect(user.password).toBeNull();
    });

    it("accepts provider-specific overrides", () => {
      const user = buildOAuthUser("github", { providerAccountId: "gh-999" });
      expect(user.provider).toBe("github");
      expect(user.providerAccountId).toBe("gh-999");
    });
  });

  describe("createUser", () => {
    it("calls prisma.user.create with the built data and returns the result", async () => {
      const mockCreate = makeMockUserCreate();
      const prisma = { user: { create: mockCreate } };

      const user = await createUser(prisma);

      expect(mockCreate).toHaveBeenCalledTimes(1);
      const [call] = mockCreate.mock.calls as [{ data: Partial<User> & { email: string } }][];
      expect(call[0].data.email).toBeTruthy();
      expect(user.id).toBe("mock-id");
    });

    it("passes overrides through to prisma.user.create", async () => {
      const mockCreate = makeMockUserCreate();
      const prisma = { user: { create: mockCreate } };

      await createUser(prisma, { email: "seeded@example.com", role: Role.ADMIN });

      const [call] = mockCreate.mock.calls as [{ data: Partial<User> & { email: string } }][];
      expect(call[0].data.email).toBe("seeded@example.com");
      expect(call[0].data.role).toBe(Role.ADMIN);
    });

    it("does not pass id, createdAt, or updatedAt to prisma", async () => {
      const mockCreate = makeMockUserCreate();
      const prisma = { user: { create: mockCreate } };

      await createUser(prisma);

      const [call] = mockCreate.mock.calls as [{ data: Record<string, unknown> }][];
      expect(call[0].data["id"]).toBeUndefined();
      expect(call[0].data["createdAt"]).toBeUndefined();
      expect(call[0].data["updatedAt"]).toBeUndefined();
    });
  });

  describe("createAdminUser", () => {
    it("creates a user with ADMIN role", async () => {
      const mockCreate = makeMockUserCreate();
      const prisma = { user: { create: mockCreate } };

      await createAdminUser(prisma);

      const [call] = mockCreate.mock.calls as [{ data: Partial<User> }][];
      expect(call[0].data.role).toBe(Role.ADMIN);
    });
  });
});

describe("RefreshTokenFactory", () => {
  const TEST_USER_ID = "user-abc-123";

  describe("buildRefreshToken", () => {
    it("returns a fully-typed RefreshToken with future expiry", () => {
      const rt = buildRefreshToken(TEST_USER_ID);

      expect(typeof rt.id).toBe("string");
      expect(typeof rt.token).toBe("string");
      expect(rt.userId).toBe(TEST_USER_ID);
      expect(rt.expiresAt.getTime()).toBeGreaterThan(Date.now());
      expect(rt.createdAt).toBeInstanceOf(Date);
    });

    it("defaults to a 7-day expiry", () => {
      const rt = buildRefreshToken(TEST_USER_ID);
      const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
      const diff = rt.expiresAt.getTime() - Date.now();

      expect(diff).toBeGreaterThan(sevenDaysMs - 5000);
      expect(diff).toBeLessThanOrEqual(sevenDaysMs);
    });

    it("applies overrides over defaults", () => {
      const customExpiry = new Date(Date.now() + 30 * 60 * 1000);
      const rt = buildRefreshToken(TEST_USER_ID, { expiresAt: customExpiry });
      expect(rt.expiresAt).toBe(customExpiry);
    });

    it("generates unique tokens on each call", () => {
      const tokens = new Set(Array.from({ length: 10 }, () => buildRefreshToken(TEST_USER_ID).token));
      expect(tokens.size).toBe(10);
    });
  });

  describe("buildExpiredRefreshToken", () => {
    it("returns a RefreshToken with a past expiry", () => {
      const rt = buildExpiredRefreshToken(TEST_USER_ID);
      expect(rt.expiresAt.getTime()).toBeLessThan(Date.now());
    });

    it("still assigns the correct userId", () => {
      const rt = buildExpiredRefreshToken(TEST_USER_ID);
      expect(rt.userId).toBe(TEST_USER_ID);
    });
  });

  describe("createRefreshToken", () => {
    it("calls prisma.refreshToken.create with the built data", async () => {
      const mockCreate = makeMockRefreshTokenCreate();
      const prisma = { refreshToken: { create: mockCreate } };

      const rt = await createRefreshToken(prisma, TEST_USER_ID);

      expect(mockCreate).toHaveBeenCalledTimes(1);
      const [call] = mockCreate.mock.calls as [{ data: { token: string; userId: string; expiresAt: Date } }][];
      expect(call[0].data.userId).toBe(TEST_USER_ID);
      expect(typeof call[0].data.token).toBe("string");
      expect(rt.id).toBe("mock-rt-id");
    });

    it("does not pass id or createdAt to prisma", async () => {
      const mockCreate = makeMockRefreshTokenCreate();
      const prisma = { refreshToken: { create: mockCreate } };

      await createRefreshToken(prisma, TEST_USER_ID);

      const [call] = mockCreate.mock.calls as [{ data: Record<string, unknown> }][];
      expect(call[0].data["id"]).toBeUndefined();
      expect(call[0].data["createdAt"]).toBeUndefined();
    });

    it("passes token override through to prisma", async () => {
      const mockCreate = makeMockRefreshTokenCreate();
      const prisma = { refreshToken: { create: mockCreate } };
      const customToken = "custom-refresh-token-value";

      await createRefreshToken(prisma, TEST_USER_ID, { token: customToken });

      const [call] = mockCreate.mock.calls as [{ data: { token: string } }][];
      expect(call[0].data.token).toBe(customToken);
    });
  });
});
