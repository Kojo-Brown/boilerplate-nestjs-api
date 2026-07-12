import { ConfigService } from "@nestjs/config";
import { Test } from "@nestjs/testing";
import { JwtStrategy } from "./jwt.strategy";

const mockConfigService = {
  getOrThrow: jest.fn().mockReturnValue("test-secret"),
};

describe("JwtStrategy", () => {
  let strategy: JwtStrategy;

  beforeEach(async () => {
    const module = await Test.createTestingModule({
      providers: [
        JwtStrategy,
        { provide: ConfigService, useValue: mockConfigService },
      ],
    }).compile();

    strategy = module.get(JwtStrategy);
  });

  it("should be defined", () => {
    expect(strategy).toBeDefined();
  });

  describe("validate()", () => {
    it("maps the JWT payload to an AuthenticatedUser shape", () => {
      const payload = { sub: "user-1", email: "test@example.com", role: "USER" };

      const result = strategy.validate(payload);

      expect(result).toEqual({ id: "user-1", email: "test@example.com", role: "USER" });
    });

    it("preserves the ADMIN role from the token payload", () => {
      const payload = { sub: "admin-1", email: "admin@example.com", role: "ADMIN" };

      const result = strategy.validate(payload);

      expect(result.role).toBe("ADMIN");
    });
  });
});
