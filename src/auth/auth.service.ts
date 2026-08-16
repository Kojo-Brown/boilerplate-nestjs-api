import { Inject, Injectable, UnauthorizedException, ConflictException } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { ConfigService } from "@nestjs/config";
import * as argon2 from "argon2";
import { UsersService } from "@/users/users.service";
import { DomainEventBus } from "@/events";
import { UNCONDITIONAL } from "@/common/concurrency";
import { REFRESH_TOKEN_STORE } from "./ports";
import type { RefreshTokenStore } from "./ports";
import type { Role, User } from "@prisma/client";
import type { RegisterDto } from "./dto/register.dto";
import type { LoginDto } from "./dto/login.dto";
import type { GoogleProfile } from "./strategies/google.strategy";

@Injectable()
export class AuthService {
  constructor(
    private readonly users: UsersService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    @Inject(REFRESH_TOKEN_STORE) private readonly refreshTokens: RefreshTokenStore,
    private readonly events: DomainEventBus,
  ) {}

  async register(dto: RegisterDto) {
    const exists = await this.users.findByEmail(dto.email);
    if (exists) throw new ConflictException("Email already in use");
    const hash = await argon2.hash(dto.password);
    const user = await this.users.create({ email: dto.email, password: hash, name: dto.name });
    this.publishRegistered(user);
    return this.issueTokens(user.id, user.email, user.role);
  }

  async login(dto: LoginDto) {
    const user = await this.users.findByEmail(dto.email);
    if (!user?.password) throw new UnauthorizedException("Invalid credentials");
    const valid = await argon2.verify(user.password, dto.password);
    if (!valid) throw new UnauthorizedException("Invalid credentials");
    return this.issueTokens(user.id, user.email, user.role);
  }

  /**
   * Rotates a refresh token: the presented one is spent, a new pair is issued.
   *
   * The claim is delegated to the store because it has to be atomic, and this
   * used to read the row, check it, and then delete it by id. Two requests
   * carrying the same token — a client retrying over a flaky connection, most
   * often — both passed the check, and only the `DELETE` separated them, by
   * raising `P2025` on a row the winner had already removed. Nothing maps that
   * to a status, so the loser was answered **500** where the truthful answer is
   * 401: the token really was spent, just not by them.
   *
   * The token stayed single-use throughout, so this is a fix to what a losing
   * client is told rather than to a replay hole. What has changed is where the
   * property lives: it was an incidental consequence of `delete`-by-id, and it
   * is now the store's stated contract, asserted against every implementation.
   *
   * Expiry stays here rather than in the store. The store decides *who* gets
   * the row; whether the credential is still acceptable is this service's
   * policy, and an expired token is spent on presentation either way — it is
   * of no further use to anyone, and leaving it behind would only mean writing
   * a sweeper for rows nobody can use.
   */
  async refresh(token: string) {
    const claimed = await this.refreshTokens.consume(token);
    if (!claimed) throw new UnauthorizedException("Invalid refresh token");
    if (claimed.expiresAt < new Date()) throw new UnauthorizedException("Refresh token expired");
    return this.issueTokens(claimed.userId, claimed.email, claimed.role);
  }

  async logout(token: string): Promise<void> {
    await this.refreshTokens.revoke(token);
  }

  async loginWithGoogle(profile: GoogleProfile) {
    let user = await this.users.findByProviderAccount("google", profile.googleId);
    if (!user) {
      const byEmail = await this.users.findByEmail(profile.email);
      if (byEmail) {
        // Unconditional, and deliberately so: linking a Google identity to an
        // existing account is driven by the OAuth callback, not by a client
        // that read a representation and is proposing an edit to it. There is
        // no version the caller could have been holding, and refusing the link
        // because an unrelated field moved would strand the sign-in.
        user = await this.users.update(
          byEmail.id,
          { provider: "google", providerAccountId: profile.googleId },
          UNCONDITIONAL,
        );
      } else {
        user = await this.users.create({
          email: profile.email,
          name: profile.name,
          provider: "google",
          providerAccountId: profile.googleId,
        });
        // Only this branch is a registration. The one above links Google to an
        // account that already exists and has already been welcomed, and the
        // outer `if` is an ordinary sign-in.
        this.publishRegistered(user);
      }
    }
    return this.issueTokens(user.id, user.email, user.role);
  }

  /**
   * Announces a new account.
   *
   * Published after the row is committed and before tokens are issued, so a
   * subscriber never reacts to a user that does not exist. It is deliberately
   * not awaited: `publish` returns once every subscriber has started, so a
   * welcome email that cannot be queued delays nothing and fails nothing here.
   */
  private publishRegistered(user: User): void {
    this.events.publish("user.registered", {
      userId: user.id,
      email: user.email,
      name: user.name,
      provider: user.provider,
    });
  }

  private async issueTokens(userId: string, email: string, role: Role) {
    const payload = { sub: userId, email, role };
    const accessToken = this.jwt.sign(payload);
    const refreshExpiry = this.config.get("JWT_REFRESH_EXPIRY", "7d");
    const expiresAt = new Date(Date.now() + ms(refreshExpiry));
    const refreshToken = crypto.randomUUID();
    await this.refreshTokens.issue({ token: refreshToken, userId, expiresAt });
    return { accessToken, refreshToken, expiresIn: 900 };
  }
}

function ms(s: string): number {
  const units: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };
  const match = /^(\d+)([smhd])$/.exec(s);
  if (!match) return 900_000;
  return parseInt(match[1]!) * (units[match[2]!] ?? 1000);
}
