import { ExecutionContext, UnauthorizedException } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { Test, TestingModule } from "@nestjs/testing";
import { JwtAuthGuard } from "./jwt-auth.guard";

const buildContext = (): ExecutionContext =>
  ({
    getHandler: jest.fn().mockReturnValue({}),
    getClass: jest.fn().mockReturnValue({}),
    switchToHttp: jest.fn().mockReturnValue({ getRequest: jest.fn().mockReturnValue({}) }),
  }) as unknown as ExecutionContext;

describe("JwtAuthGuard", () => {
  let guard: JwtAuthGuard;
  let reflector: jest.Mocked<Pick<Reflector, "getAllAndOverride">>;

  beforeEach(async () => {
    reflector = { getAllAndOverride: jest.fn() };
    const module: TestingModule = await Test.createTestingModule({
      providers: [JwtAuthGuard, { provide: Reflector, useValue: reflector }],
    }).compile();
    guard = module.get(JwtAuthGuard);
  });

  afterEach(() => jest.resetAllMocks());

  describe("canActivate", () => {
    it("returns true immediately for public routes without invoking passport", () => {
      reflector.getAllAndOverride.mockReturnValue(true);
      expect(guard.canActivate(buildContext())).toBe(true);
    });

    it("checks IS_PUBLIC_KEY metadata on handler and class", () => {
      reflector.getAllAndOverride.mockReturnValue(true);
      const ctx = buildContext();
      guard.canActivate(ctx);
      expect(reflector.getAllAndOverride).toHaveBeenCalledWith(
        "isPublic",
        [expect.anything(), expect.anything()],
      );
    });
  });

  describe("handleRequest", () => {
    it("returns the authenticated user when no error", () => {
      const user = { id: "u1", email: "a@b.com", role: "USER" };
      expect(guard.handleRequest(null, user)).toBe(user);
    });

    it("throws UnauthorizedException when user is false", () => {
      expect(() => guard.handleRequest(null, false)).toThrow(UnauthorizedException);
    });

    it("throws UnauthorizedException when an error is passed", () => {
      expect(() => guard.handleRequest(new Error("Token expired"), false)).toThrow(
        UnauthorizedException,
      );
    });

    it("throws UnauthorizedException with descriptive message", () => {
      expect(() => guard.handleRequest(null, false)).toThrow(
        "Invalid or missing authentication token",
      );
    });
  });
});
