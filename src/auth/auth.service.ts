import { Inject, Injectable, UnauthorizedException, ConflictException } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { ConfigService } from "@nestjs/config";
import { CommandBus, QueryBus } from "@nestjs/cqrs";
import * as argon2 from "argon2";
import { CreateUserCommand, UpdateUserCommand } from "@/users/write";
import { FindUserByEmailQuery, FindUserByProviderAccountQuery } from "@/users/read";
import { TRANSACTION_RUNNER } from "@/common/prisma/transaction.port";
import type { TransactionContext, TransactionRunner } from "@/common/prisma/transaction.port";
import { TransactionalOutbox } from "@/outbox";
import { UNCONDITIONAL } from "@/common/concurrency";
import { REFRESH_TOKEN_STORE } from "./ports";
import type { RefreshTokenStore } from "./ports";
import type { Role, User } from "@prisma/client";
import type { RegisterDto } from "./dto/register.dto";
import type { LoginDto } from "./dto/login.dto";
import type { GoogleProfile } from "./strategies/google.strategy";

/**
 * Authentication, which reaches the users module only through its buses.
 *
 * There is no `UsersModule` import here any more and no users service to
 * inject: this dispatches `CreateUserCommand`, `UpdateUserCommand`,
 * `FindUserByEmailQuery` and `FindUserByProviderAccountQuery`, and the
 * container resolves whichever handlers are registered for them. The dependency
 * that remains is on the four request shapes rather than on a class with
 * fourteen methods, which is the inversion CQRS buys here — the users module
 * can split a handler in two, or move where a user row lives, without this file
 * changing.
 */
@Injectable()
export class AuthService {
  constructor(
    private readonly commands: CommandBus,
    private readonly queries: QueryBus,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    @Inject(REFRESH_TOKEN_STORE) private readonly refreshTokens: RefreshTokenStore,
    @Inject(TRANSACTION_RUNNER) private readonly transactions: TransactionRunner,
    private readonly outbox: TransactionalOutbox,
  ) {}

  async register(dto: RegisterDto) {
    const exists = await this.queries.execute(new FindUserByEmailQuery(dto.email));
    if (exists) throw new ConflictException("Email already in use");
    const hash = await argon2.hash(dto.password);
    // The row and the event commit together or not at all. Hashing stays
    // outside: argon2 is deliberately slow, and holding a database connection
    // and the transaction's locks for the duration of a KDF is exactly the kind
    // of work a transaction should never contain.
    const user = await this.transactions.run(async (tx) => {
      const created = await this.commands.execute(
        new CreateUserCommand({ email: dto.email, password: hash, name: dto.name }, tx),
      );
      await this.stageRegistered(tx, created);
      return created;
    });
    return this.issueTokens(user.id, user.email, user.role);
  }

  async login(dto: LoginDto) {
    const user = await this.queries.execute(new FindUserByEmailQuery(dto.email));
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
    let user = await this.queries.execute(
      new FindUserByProviderAccountQuery("google", profile.googleId),
    );
    if (!user) {
      const byEmail = await this.queries.execute(new FindUserByEmailQuery(profile.email));
      if (byEmail) {
        // Unconditional, and deliberately so: linking a Google identity to an
        // existing account is driven by the OAuth callback, not by a client
        // that read a representation and is proposing an edit to it. There is
        // no version the caller could have been holding, and refusing the link
        // because an unrelated field moved would strand the sign-in.
        user = await this.commands.execute(
          new UpdateUserCommand(
            byEmail.id,
            { provider: "google", providerAccountId: profile.googleId },
            UNCONDITIONAL,
          ),
        );
      } else {
        // Only this branch is a registration. The one above links Google to an
        // account that already exists and has already been welcomed, and the
        // outer `if` is an ordinary sign-in.
        user = await this.transactions.run(async (tx) => {
          const created = await this.commands.execute(
            new CreateUserCommand(
              {
                email: profile.email,
                name: profile.name,
                provider: "google",
                providerAccountId: profile.googleId,
              },
              tx,
            ),
          );
          await this.stageRegistered(tx, created);
          return created;
        });
      }
    }
    return this.issueTokens(user.id, user.email, user.role);
  }

  /**
   * Announces a new account, durably.
   *
   * Staged inside the transaction that creates the row rather than published
   * after it. The two failures that removes are the ones a bare emitter cannot
   * avoid: a registration that succeeds while the welcome is lost to a crash
   * between the insert and the emit, and — the other way round — a
   * `user.registered` for an insert that went on to roll back. Neither is
   * survivable by ordering the two statements more carefully; only one commit
   * carrying both is.
   *
   * What the caller gives up is immediacy. The subscriber runs on the relay's
   * next poll rather than on this stack, which is a change a test can see (the
   * e2e suite drains the relay explicitly) and which `docs/outbox.md` states as
   * the cost of the trade.
   */
  private async stageRegistered(tx: TransactionContext, user: User): Promise<void> {
    await this.outbox.stage(tx, "user.registered", {
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
