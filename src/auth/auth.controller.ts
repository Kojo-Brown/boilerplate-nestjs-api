import { Controller, Post, Body, Get, Req, UseGuards, HttpCode, HttpStatus } from "@nestjs/common";
import { Throttle, SkipThrottle } from "@nestjs/throttler";
import {
  ApiTags,
  ApiOperation,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiNoContentResponse,
  ApiExcludeEndpoint,
} from "@nestjs/swagger";
import { AuthService } from "./auth.service";
import { RegisterDto } from "./dto/register.dto";
import { LoginDto } from "./dto/login.dto";
import { RefreshTokenDto } from "./dto/refresh-token.dto";
import { AuthTokensDto } from "./dto/auth-tokens.dto";
import { AuthenticatedUserDto } from "./dto/authenticated-user.dto";
import { JwtAuthGuard } from "./guards/jwt-auth.guard";
import { GoogleAuthGuard } from "./guards/google-auth.guard";
import { CurrentUser } from "@/common/decorators/current-user.decorator";
import { ApiJwtAuth } from "@/common/swagger/api-jwt-auth.decorator";
import { ApiCommonErrors, ApiConflict } from "@/common/swagger/api-error-responses.decorator";
import type { AuthenticatedUser } from "./strategies/jwt.strategy";
import type { GoogleProfile } from "./strategies/google.strategy";

@ApiTags("auth")
@Controller("auth")
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post("register")
  @ApiOperation({ summary: "Register a new user", description: "Creates an account and returns a JWT token pair." })
  @ApiCreatedResponse({ type: AuthTokensDto, description: "Account created — tokens issued" })
  @ApiConflict("Email is already registered")
  @ApiCommonErrors()
  register(@Body() dto: RegisterDto) {
    return this.auth.register(dto);
  }

  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post("login")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Log in", description: "Validates credentials and returns a JWT token pair." })
  @ApiOkResponse({ type: AuthTokensDto, description: "Login successful — tokens issued" })
  @ApiCommonErrors()
  login(@Body() dto: LoginDto) {
    return this.auth.login(dto);
  }

  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post("refresh")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Rotate refresh token",
    description:
      "Exchanges a valid refresh token for a new token pair. The submitted token is immediately invalidated (single-use).",
  })
  @ApiOkResponse({ type: AuthTokensDto, description: "Tokens rotated successfully" })
  @ApiCommonErrors()
  refresh(@Body() dto: RefreshTokenDto) {
    return this.auth.refresh(dto.refreshToken);
  }

  @SkipThrottle()
  @Post("logout")
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiJwtAuth()
  @ApiOperation({ summary: "Log out", description: "Revokes the provided refresh token." })
  @ApiNoContentResponse({ description: "Token revoked — session ended" })
  logout(@Body() dto: RefreshTokenDto) {
    return this.auth.logout(dto.refreshToken);
  }

  @SkipThrottle()
  @Get("me")
  @UseGuards(JwtAuthGuard)
  @ApiJwtAuth()
  @ApiOperation({
    summary: "Get current user",
    description: "Returns the authenticated user's profile decoded from the JWT payload.",
  })
  @ApiOkResponse({ type: AuthenticatedUserDto })
  me(@CurrentUser() user: AuthenticatedUser) {
    return user;
  }

  @SkipThrottle()
  @Get("google")
  @UseGuards(GoogleAuthGuard)
  @ApiExcludeEndpoint()
  googleLogin(): void {
    // Passport redirects to Google — this handler body is never reached
  }

  @SkipThrottle()
  @Get("google/callback")
  @UseGuards(GoogleAuthGuard)
  @ApiExcludeEndpoint()
  googleCallback(@Req() req: { user: GoogleProfile }) {
    return this.auth.loginWithGoogle(req.user);
  }
}
