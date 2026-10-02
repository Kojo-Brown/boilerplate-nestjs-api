import { UnauthorizedException } from "@nestjs/common";
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
      providers: [JwtStrategy, { provide: ConfigService, useValue: mockConfigService }],
    }).compile();

    strategy = module.get(JwtStrategy);
  });

  it("should be defined", () => {
    expect(strategy).toBeDefined();
  });

  describe("validate()", () => {
    it("maps the JWT payload to an AuthenticatedUser shape", () => {
      const payload = { sub: "user-1", email: "test@example.com", role: "USER", tid: "acme" };

      const result = strategy.validate(payload);

      expect(result).toEqual({
        id: "user-1",
        email: "test@example.com",
        role: "USER",
        tenantId: "acme",
      });
    });

    it("preserves the ADMIN role from the token payload", () => {
      const payload = { sub: "admin-1", email: "admin@example.com", role: "ADMIN", tid: "acme" };

      const result = strategy.validate(payload);

      expect(result.role).toBe("ADMIN");
    });

    // A token minted before tenancy existed verifies perfectly and names no
    // tenant. Defaulting it into one would mean a credential whose scope this
    // service chose for it, so it is refused — and since access tokens live
    // fifteen minutes, the refusal costs one refresh per client at most.
    it("refuses a token with no tenant claim", () => {
      const payload = { sub: "user-1", email: "test@example.com", role: "USER" };

      expect(() => strategy.validate(payload)).toThrow(UnauthorizedException);
    });

    // Not merely absent: present and not a tenant id. `tid` reaches
    // `set_config` and is compared against a column with a CHECK constraint, so
    // the claim is validated rather than trusted for having been signed — a
    // token signed with the right key is not a token whose claims are right.
    it.each([["Acme"], [""], ["acme.corp"], ["a"], ["-acme"]])(
      "refuses a token whose tenant claim is %p",
      (tid) => {
        const payload = { sub: "user-1", email: "test@example.com", role: "USER", tid };

        expect(() => strategy.validate(payload)).toThrow(UnauthorizedException);
      },
    );
  });
});
