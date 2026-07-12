import { Test, TestingModule } from "@nestjs/testing";
import { AuthController } from "./auth.controller";
import { AuthService } from "./auth.service";
import type { AuthenticatedUser } from "./strategies/jwt.strategy";
import type { GoogleProfile } from "./strategies/google.strategy";

const mockTokens = { accessToken: "access", refreshToken: "refresh", expiresIn: 900 };

const mockAuthService = {
  register: jest.fn(),
  login: jest.fn(),
  refresh: jest.fn(),
  logout: jest.fn(),
  loginWithGoogle: jest.fn(),
};

describe("AuthController", () => {
  let controller: AuthController;

  beforeEach(async () => {
    jest.resetAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      controllers: [AuthController],
      providers: [{ provide: AuthService, useValue: mockAuthService }],
    }).compile();

    controller = module.get(AuthController);
  });

  it("should be defined", () => {
    expect(controller).toBeDefined();
  });

  describe("register()", () => {
    it("delegates to AuthService.register and returns the result", async () => {
      mockAuthService.register.mockResolvedValue(mockTokens);
      const dto = { email: "user@example.com", password: "Password1!" };

      const result = await controller.register(dto);

      expect(mockAuthService.register).toHaveBeenCalledWith(dto);
      expect(result).toBe(mockTokens);
    });
  });

  describe("login()", () => {
    it("delegates to AuthService.login and returns tokens", async () => {
      mockAuthService.login.mockResolvedValue(mockTokens);
      const dto = { email: "user@example.com", password: "Password1!" };

      const result = await controller.login(dto);

      expect(mockAuthService.login).toHaveBeenCalledWith(dto);
      expect(result).toBe(mockTokens);
    });
  });

  describe("refresh()", () => {
    it("delegates to AuthService.refresh with the refresh token string", async () => {
      mockAuthService.refresh.mockResolvedValue(mockTokens);

      const result = await controller.refresh({ refreshToken: "rt-value" });

      expect(mockAuthService.refresh).toHaveBeenCalledWith("rt-value");
      expect(result).toBe(mockTokens);
    });
  });

  describe("logout()", () => {
    it("delegates to AuthService.logout with the refresh token string", async () => {
      mockAuthService.logout.mockResolvedValue(undefined);

      await controller.logout({ refreshToken: "rt-value" });

      expect(mockAuthService.logout).toHaveBeenCalledWith("rt-value");
    });
  });

  describe("me()", () => {
    it("returns the user from the JWT payload as-is", () => {
      const user: AuthenticatedUser = { id: "u1", email: "user@example.com", role: "USER" };

      const result = controller.me(user);

      expect(result).toBe(user);
    });
  });

  describe("googleLogin()", () => {
    it("returns void (Passport handles the redirect)", () => {
      const result = controller.googleLogin();
      expect(result).toBeUndefined();
    });
  });

  describe("googleCallback()", () => {
    it("delegates to AuthService.loginWithGoogle with the profile from the request", async () => {
      mockAuthService.loginWithGoogle.mockResolvedValue(mockTokens);
      const profile: GoogleProfile = { googleId: "g-1", email: "g@example.com", name: "G User" };

      const result = await controller.googleCallback({ user: profile });

      expect(mockAuthService.loginWithGoogle).toHaveBeenCalledWith(profile);
      expect(result).toBe(mockTokens);
    });
  });
});
