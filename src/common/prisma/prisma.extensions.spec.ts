import { DEFAULT_USER_PREFERENCES } from "@/users/types/user-preferences";
import type { UserPreferences } from "@/users/types/user-preferences";

const mockFindUnique = jest.fn();
const mockUpdate = jest.fn();

jest.mock("@prisma/client", () => {
  const actual = jest.requireActual<typeof import("@prisma/client")>("@prisma/client");
  return {
    ...actual,
    Prisma: {
      ...actual.Prisma,
      defineExtension: (ext: unknown) => ext,
      getExtensionContext: () => ({
        findUnique: mockFindUnique,
        update: mockUpdate,
      }),
    },
  };
});

import { preferencesExtension } from "./prisma.extensions";

const userExtension = (
  preferencesExtension as { model: { user: Record<string, Function> } }
).model.user;

describe("preferencesExtension", () => {
  beforeEach(() => {
    jest.resetAllMocks();
  });

  describe("getPreferences", () => {
    it("returns defaults when user has no stored preferences", async () => {
      mockFindUnique.mockResolvedValue({ preferences: null });
      const result = await userExtension["getPreferences"].call({}, "user-1");
      expect(result).toEqual(DEFAULT_USER_PREFERENCES);
    });

    it("merges stored preferences over defaults", async () => {
      const stored: Partial<UserPreferences> = { theme: "dark", timezone: "Europe/London" };
      mockFindUnique.mockResolvedValue({ preferences: stored });
      const result = await userExtension["getPreferences"].call({}, "user-1");
      expect(result).toEqual({ ...DEFAULT_USER_PREFERENCES, ...stored });
    });

    it("returns defaults when user record is missing", async () => {
      mockFindUnique.mockResolvedValue(null);
      const result = await userExtension["getPreferences"].call({}, "user-1");
      expect(result).toEqual(DEFAULT_USER_PREFERENCES);
    });
  });

  describe("setPreferences", () => {
    it("merges patch over current preferences and persists", async () => {
      const current: Partial<UserPreferences> = { theme: "dark" };
      mockFindUnique.mockResolvedValue({ preferences: current });
      mockUpdate.mockResolvedValue({});

      const patch: Partial<UserPreferences> = { language: "fr" };
      const result = await userExtension["setPreferences"].call({}, "user-1", patch);

      expect(result).toEqual({ ...DEFAULT_USER_PREFERENCES, theme: "dark", language: "fr" });
      expect(mockUpdate).toHaveBeenCalledWith({
        where: { id: "user-1" },
        data: {
          preferences: { ...DEFAULT_USER_PREFERENCES, theme: "dark", language: "fr" },
        },
      });
    });

    it("throws when user is not found", async () => {
      mockFindUnique.mockResolvedValue(null);
      await expect(
        userExtension["setPreferences"].call({}, "missing", { theme: "light" }),
      ).rejects.toThrow("User missing not found");
    });
  });
});
