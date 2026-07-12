import { Test, TestingModule } from "@nestjs/testing";
import { GoogleAuthGuard } from "./google-auth.guard";

describe("GoogleAuthGuard", () => {
  let guard: GoogleAuthGuard;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [GoogleAuthGuard],
    }).compile();

    guard = module.get(GoogleAuthGuard);
  });

  it("should be defined", () => {
    expect(guard).toBeDefined();
  });

  it("exposes canActivate from the Passport AuthGuard base class", () => {
    expect(typeof guard.canActivate).toBe("function");
  });
});
