import { Logger, Module, type Provider } from "@nestjs/common";
import { JwtModule } from "@nestjs/jwt";
import { PassportModule } from "@nestjs/passport";
import { ConfigService } from "@nestjs/config";
import { AuthService } from "./auth.service";
import { AuthController } from "./auth.controller";
import { JwtStrategy } from "./strategies/jwt.strategy";
import { GoogleStrategy } from "./strategies/google.strategy";
import { JwtAuthGuard } from "./guards/jwt-auth.guard";
import { RolesGuard } from "./guards/roles.guard";
import { UsersModule } from "@/users/users.module";

/**
 * Google OAuth is optional (`GOOGLE_*` are optional in the env schema), but
 * passport-google-oauth20 throws from its constructor when `clientID` is blank.
 * Registering the strategy unconditionally therefore makes the whole app fail to
 * boot on any deployment that does not use Google sign-in, so it is only
 * instantiated once both credentials are present.
 */
export const googleStrategyProvider: Provider = {
  provide: GoogleStrategy,
  inject: [ConfigService],
  useFactory: (config: ConfigService): GoogleStrategy | null => {
    const clientId = config.get<string>("GOOGLE_CLIENT_ID");
    const clientSecret = config.get<string>("GOOGLE_CLIENT_SECRET");

    if (!clientId || !clientSecret) {
      new Logger(AuthModule.name).warn(
        "GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET are not set — Google sign-in is disabled.",
      );
      return null;
    }

    return new GoogleStrategy(config);
  },
};

@Module({
  imports: [
    PassportModule,
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.getOrThrow("JWT_SECRET"),
        signOptions: { expiresIn: config.get("JWT_ACCESS_EXPIRY", "15m") },
      }),
    }),
    UsersModule,
  ],
  controllers: [AuthController],
  providers: [AuthService, JwtStrategy, googleStrategyProvider, JwtAuthGuard, RolesGuard],
  exports: [AuthService, JwtAuthGuard, RolesGuard],
})
export class AuthModule {}
