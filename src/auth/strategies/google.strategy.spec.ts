import { Test, TestingModule } from "@nestjs/testing";
import { ConfigService } from "@nestjs/config";
import { GoogleStrategy, type GoogleProfile } from "./google.strategy";
import type { Profile, VerifyCallback } from "passport-google-oauth20";

const mockConfig = {
  get: jest.fn().mockReturnValue(""),
};

const makeProfile = (overrides: Partial<Profile> = {}): Profile =>
  ({
    id: "google-uid-123",
    displayName: "Test User",
    emails: [{ value: "test@example.com", verified: "true" }],
    photos: [],
    provider: "google",
    _raw: "",
    _json: {} as Profile["_json"],
    ...overrides,
  }) as Profile;

describe("GoogleStrategy", () => {
  let strategy: GoogleStrategy;

  beforeEach(async () => {
    jest.resetAllMocks();
    mockConfig.get.mockReturnValue("");

    const module: TestingModule = await Test.createTestingModule({
      providers: [GoogleStrategy, { provide: ConfigService, useValue: mockConfig }],
    }).compile();

    strategy = module.get<GoogleStrategy>(GoogleStrategy);
  });

  describe("validate", () => {
    it("calls done with an error when the profile has no emails", () => {
      const profile = makeProfile({ emails: [] });
      const done = jest.fn() as jest.MockedFunction<VerifyCallback>;

      strategy.validate("access-token", "refresh-token", profile, done);

      expect(done).toHaveBeenCalledWith(expect.any(Error), undefined);
    });

    it("calls done with an error when emails array is undefined", () => {
      const profile = makeProfile({ emails: undefined });
      const done = jest.fn() as jest.MockedFunction<VerifyCallback>;

      strategy.validate("access-token", "refresh-token", profile, done);

      expect(done).toHaveBeenCalledWith(expect.any(Error), undefined);
    });

    it("calls done with a GoogleProfile when a valid email is present", () => {
      const profile = makeProfile();
      const done = jest.fn() as jest.MockedFunction<VerifyCallback>;

      strategy.validate("access-token", "refresh-token", profile, done);

      const expected: GoogleProfile = {
        googleId: "google-uid-123",
        email: "test@example.com",
        name: "Test User",
      };
      expect(done).toHaveBeenCalledWith(null, expected);
    });

    it("maps displayName to name in the returned profile", () => {
      const profile = makeProfile({ displayName: "Jane Doe" });
      const done = jest.fn() as jest.MockedFunction<VerifyCallback>;

      strategy.validate("access-token", "refresh-token", profile, done);

      expect(done).toHaveBeenCalledWith(null, expect.objectContaining({ name: "Jane Doe" }));
    });

    it("maps profile.id to googleId in the returned profile", () => {
      const profile = makeProfile({ id: "unique-google-id-999" });
      const done = jest.fn() as jest.MockedFunction<VerifyCallback>;

      strategy.validate("access-token", "refresh-token", profile, done);

      expect(done).toHaveBeenCalledWith(null, expect.objectContaining({ googleId: "unique-google-id-999" }));
    });
  });
});
