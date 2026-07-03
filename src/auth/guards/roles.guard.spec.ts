import { ExecutionContext, ForbiddenException } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { Test, TestingModule } from "@nestjs/testing";
import { Role } from "@prisma/client";
import { RolesGuard } from "./roles.guard";

const buildContext = (user?: { id: string; email: string; role: string }): ExecutionContext =>
  ({
    getHandler: jest.fn().mockReturnValue({}),
    getClass: jest.fn().mockReturnValue({}),
    switchToHttp: jest.fn().mockReturnValue({
      getRequest: jest.fn().mockReturnValue({ user }),
    }),
  }) as unknown as ExecutionContext;

describe("RolesGuard", () => {
  let guard: RolesGuard;
  let reflector: jest.Mocked<Pick<Reflector, "getAllAndOverride">>;

  beforeEach(async () => {
    reflector = { getAllAndOverride: jest.fn() };
    const module: TestingModule = await Test.createTestingModule({
      providers: [RolesGuard, { provide: Reflector, useValue: reflector }],
    }).compile();
    guard = module.get(RolesGuard);
  });

  afterEach(() => jest.resetAllMocks());

  it("returns true when no roles are required on the handler", () => {
    reflector.getAllAndOverride.mockReturnValue(undefined);
    expect(guard.canActivate(buildContext())).toBe(true);
  });

  it("returns true when required roles array is empty", () => {
    reflector.getAllAndOverride.mockReturnValue([]);
    expect(guard.canActivate(buildContext())).toBe(true);
  });

  it("returns true when user role is in required roles", () => {
    reflector.getAllAndOverride.mockReturnValue([Role.ADMIN]);
    const ctx = buildContext({ id: "u1", email: "a@b.com", role: "ADMIN" });
    expect(guard.canActivate(ctx)).toBe(true);
  });

  it("returns true when USER role is required and user has USER role", () => {
    reflector.getAllAndOverride.mockReturnValue([Role.USER]);
    const ctx = buildContext({ id: "u1", email: "a@b.com", role: "USER" });
    expect(guard.canActivate(ctx)).toBe(true);
  });

  it("throws ForbiddenException when user role does not match required roles", () => {
    reflector.getAllAndOverride.mockReturnValue([Role.ADMIN]);
    const ctx = buildContext({ id: "u1", email: "a@b.com", role: "USER" });
    expect(() => guard.canActivate(ctx)).toThrow(ForbiddenException);
  });

  it("throws ForbiddenException when no user is attached to request", () => {
    reflector.getAllAndOverride.mockReturnValue([Role.ADMIN]);
    expect(() => guard.canActivate(buildContext(undefined))).toThrow(ForbiddenException);
  });

  it("throws ForbiddenException with access denied message when user is missing", () => {
    reflector.getAllAndOverride.mockReturnValue([Role.ADMIN]);
    expect(() => guard.canActivate(buildContext(undefined))).toThrow("Access denied");
  });

  it("throws ForbiddenException mentioning the user role when role is wrong", () => {
    reflector.getAllAndOverride.mockReturnValue([Role.ADMIN]);
    const ctx = buildContext({ id: "u1", email: "a@b.com", role: "USER" });
    expect(() => guard.canActivate(ctx)).toThrow("USER");
  });

  it("checks ROLES_KEY metadata on handler and class", () => {
    reflector.getAllAndOverride.mockReturnValue(undefined);
    guard.canActivate(buildContext());
    expect(reflector.getAllAndOverride).toHaveBeenCalledWith(
      "roles",
      [expect.anything(), expect.anything()],
    );
  });
});
