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

/**
 * `defineExtension` is mocked above to return its argument verbatim, so the
 * import is the plain literal — described here with the precise shape of the
 * two model methods rather than an untyped `Record<string, Function>`.
 */
type PreferencesModel = {
  getPreferences(this: unknown, id: string): Promise<UserPreferences>;
  setPreferences(
    this: unknown,
    id: string,
    patch: Partial<UserPreferences>,
  ): Promise<UserPreferences>;
};

const userExtension = (preferencesExtension as unknown as { model: { user: PreferencesModel } })
  .model.user;

describe("preferencesExtension", () => {
  beforeEach(() => {
    jest.resetAllMocks();
  });

  describe("getPreferences", () => {
    it("returns defaults when user has no stored preferences", async () => {
      mockFindUnique.mockResolvedValue({ preferences: null });
      const result = await userExtension.getPreferences.call({}, "user-1");
      expect(result).toEqual(DEFAULT_USER_PREFERENCES);
    });

    it("merges stored preferences over defaults", async () => {
      const stored: Partial<UserPreferences> = { theme: "dark", timezone: "Europe/London" };
      mockFindUnique.mockResolvedValue({ preferences: stored });
      const result = await userExtension.getPreferences.call({}, "user-1");
      expect(result).toEqual({ ...DEFAULT_USER_PREFERENCES, ...stored });
    });

    it("returns defaults when user record is missing", async () => {
      mockFindUnique.mockResolvedValue(null);
      const result = await userExtension.getPreferences.call({}, "user-1");
      expect(result).toEqual(DEFAULT_USER_PREFERENCES);
    });
  });

  describe("setPreferences", () => {
    it("merges patch over current preferences and persists", async () => {
      const current: Partial<UserPreferences> = { theme: "dark" };
      mockFindUnique.mockResolvedValue({ preferences: current });
      mockUpdate.mockResolvedValue({});

      const patch: Partial<UserPreferences> = { language: "fr" };
      const result = await userExtension.setPreferences.call({}, "user-1", patch);

      expect(result).toEqual({ ...DEFAULT_USER_PREFERENCES, theme: "dark", language: "fr" });
      expect(mockUpdate).toHaveBeenCalledWith({
        where: { id: "user-1" },
        data: {
          preferences: { ...DEFAULT_USER_PREFERENCES, theme: "dark", language: "fr" },
        },
      });
    });

    it("persists a patch shaped like the DTO the controller actually passes", async () => {
      // `UpdateUserPreferencesDto` is a class, and under `target: ES2022` its
      // fields are defined on construction — so a request body naming one
      // preference reaches this extension as an object with every key, the
      // untouched ones `undefined`. Spreading that straight over the current
      // value wrote `undefined` for all of them, and since `JSON.stringify`
      // drops `undefined`, the column came back holding only the one field the
      // user changed. Turning on SMS erased their theme, language and timezone.
      const current: Partial<UserPreferences> = { theme: "dark", language: "fr" };
      mockFindUnique.mockResolvedValue({ preferences: current });
      mockUpdate.mockResolvedValue({});

      const dtoShapedPatch = {
        theme: undefined,
        language: undefined,
        emailNotifications: undefined,
        smsNotifications: true,
        pushNotifications: undefined,
        timezone: undefined,
      } as Partial<UserPreferences>;

      const result = await userExtension.setPreferences.call({}, "user-1", dtoShapedPatch);

      expect(result).toEqual({
        ...DEFAULT_USER_PREFERENCES,
        theme: "dark",
        language: "fr",
        smsNotifications: true,
      });
    });

    it("throws when user is not found", async () => {
      mockFindUnique.mockResolvedValue(null);
      await expect(
        userExtension.setPreferences.call({}, "missing", { theme: "light" }),
      ).rejects.toThrow("User missing not found");
    });
  });
});
