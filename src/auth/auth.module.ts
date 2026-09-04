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
import { PrismaRefreshTokenStore } from "./prisma-refresh-token.store";
import { REFRESH_TOKEN_STORE } from "./ports";

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
    // `UsersModule` is deliberately absent. `AuthService` reaches the users
    // module by dispatching commands and queries onto the global buses, so the
    // import edge that used to exist only to inject `UsersService` is gone.
  ],
  controllers: [AuthController],
  providers: [
    AuthService,
    // Bound by token so a suite can substitute a store without a database, and
    // so `AuthService` names no persistence technology (DIP). `useClass` rather
    // than listing the class as well: nothing injects the concrete adapter.
    { provide: REFRESH_TOKEN_STORE, useClass: PrismaRefreshTokenStore },
    JwtStrategy,
    googleStrategyProvider,
    JwtAuthGuard,
    RolesGuard,
  ],
  // `JwtModule` is re-exported so `RealtimeModule` can verify a WebSocket
  // handshake with the same `JwtService` that signed the token. Registering a
  // second one there would be a second place the secret and the signing options
  // are configured, and the failure when they drift is an access token this API
  // issues that its own gateway refuses.
  exports: [AuthService, JwtAuthGuard, RolesGuard, JwtModule],
})
export class AuthModule {}
