import {
  ConflictException,
  Inject,
  Injectable,
  Logger,
  UnauthorizedException,
} from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { ConfigService } from "@nestjs/config";
import { CommandBus, QueryBus } from "@nestjs/cqrs";
import * as argon2 from "argon2";
import { CreateUserCommand, UpdateUserCommand } from "@/users/write";
import { FindUserByEmailQuery, FindUserByProviderAccountQuery } from "@/users/read";
import { TRANSACTION_RUNNER } from "@/common/prisma/transaction.port";
import type { TransactionContext, TransactionRunner } from "@/common/prisma/transaction.port";
import { TransactionalOutbox } from "@/outbox";
import { AuditLog } from "@/audit";
import { UNCONDITIONAL } from "@/common/concurrency";
import { REFRESH_TOKEN_STORE } from "./ports";
import type { RefreshTokenReuse, RefreshTokenStore } from "./ports";
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
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly commands: CommandBus,
    private readonly queries: QueryBus,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    @Inject(REFRESH_TOKEN_STORE) private readonly refreshTokens: RefreshTokenStore,
    @Inject(TRANSACTION_RUNNER) private readonly transactions: TransactionRunner,
    private readonly outbox: TransactionalOutbox,
    private readonly audit: AuditLog,
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
   * Rotates a refresh token: the presented one is spent, a new pair is issued
   * into the same family.
   *
   * Every rejection answers "Invalid refresh token", whatever the store found.
   * The four outcomes are worth telling apart *here* — one of them revokes a
   * session and writes to the audit log — and are worth nothing to the caller:
   * a client cannot act on the difference, and an attacker probing stolen
   * tokens would read "revoked" as confirmation that the token was real and
   * "unknown" as confirmation that it was not. The expired case keeps its own
   * message because it is the one failure a legitimate client causes by simply
   * waiting, and telling it apart is the difference between "sign in again" and
   * a support ticket.
   *
   * `reused` is the case this method exists for. By the time a spent token is
   * presented again, two parties have held it and nothing in the request says
   * which one is presenting it now — so the family is already revoked by the
   * time this runs, including the successor the legitimate client is holding.
   * That is the trade `docs/refresh-token-rotation.md` argues for and states
   * the cost of: a client that retries a refresh over a flaky connection
   * without persisting the new token first will be signed out.
   */
  async refresh(token: string) {
    const claim = await this.refreshTokens.consume(token);

    switch (claim.outcome) {
      case "unknown":
      case "revoked":
        throw new UnauthorizedException("Invalid refresh token");
      case "reused":
        await this.recordReuse(claim.reuse);
        throw new UnauthorizedException("Invalid refresh token");
      case "claimed": {
        if (claim.token.expiresAt < new Date()) {
          throw new UnauthorizedException("Refresh token expired");
        }
        return this.issueTokens(
          claim.token.userId,
          claim.token.email,
          claim.token.role,
          claim.token.familyId,
        );
      }
    }
  }

  /**
   * Leaves evidence that a session was revoked as a replay, without letting
   * that failing turn a 401 into a 500.
   *
   * The security response has already happened — the store revoked the family
   * inside the transaction that detected the replay, and nothing here can undo
   * or complete it. What is left is the record, and a record that cannot be
   * written must not take the rejection down with it: the caller would get a
   * 500, which reads as "try again" to a client and as "this endpoint is
   * fragile" to an attacker. So the append is attempted, and its failure is
   * logged at `error` with the same facts the entry would have carried, which
   * is the fallback an operator can still find.
   *
   * Recorded with no actor, and in its own transaction: there is no unit of
   * work to join here, because the write this is evidence of committed in the
   * store before this method was reached. See `RefreshTokenReuseAudit` for why
   * the account is not named as the actor.
   */
  private async recordReuse(reuse: RefreshTokenReuse): Promise<void> {
    this.logger.warn(
      `Refresh-token reuse detected: family=${reuse.familyId} user=${reuse.userId} ` +
        `revokedTokens=${reuse.revokedTokens}. The session has been revoked.`,
    );

    try {
      await this.transactions.run((tx) =>
        this.audit.record(
          tx,
          "auth.refresh_token_reuse_detected",
          reuse.familyId,
          { userId: reuse.userId, revokedTokens: reuse.revokedTokens },
          { actor: null },
        ),
      );
    } catch (error) {
      this.logger.error(
        `Failed to record refresh-token reuse for family=${reuse.familyId} ` +
          `user=${reuse.userId}: the session was still revoked.`,
        error instanceof Error ? error.stack : String(error),
      );
    }
  }

  /**
   * Ends the session, not just the token.
   *
   * `revoke` takes the whole family down, which is what signing out means: the
   * chain is finished with, and every token in it — including the spent ones,
   * which are now kept rather than deleted — must stop being a credential.
   */
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
    // Recorded as well as announced, and the two are not redundant. The event
    // is a message: it is consumed, and an outbox row is pruned once it has
    // been. The audit entry is evidence — kept, in a table nothing may modify,
    // chained to the entry before it. "When was this account created, and by
    // which route" is a question asked years later, long after the event that
    // carried the same facts has been delivered and swept.
    //
    // The actor is the account itself. Nobody else registered it, and recording
    // `null` here would say the system did — which is the one thing that would
    // be untrue of every self-service sign-up.
    //
    // Last in the transaction deliberately: the append holds a global advisory
    // lock until this unit of work commits. See `PrismaAuditLogStore`.
    await this.audit.record(
      tx,
      "user.registered",
      user.id,
      { email: user.email, provider: user.provider },
      { actor: { id: user.id, role: user.role } },
    );
  }

  /**
   * Mints a pair, continuing `familyId` when this is a rotation and starting a
   * family when it is a fresh sign-in.
   *
   * The distinction is the whole mechanism: a rotation that started a new
   * family every time would leave every previous token in a chain of its own,
   * with nothing for a replay to revoke but the one token that was replayed.
   */
  private async issueTokens(userId: string, email: string, role: Role, familyId?: string) {
    const payload = { sub: userId, email, role };
    const accessToken = this.jwt.sign(payload);
    const refreshExpiry = this.config.get("JWT_REFRESH_EXPIRY", "7d");
    const expiresAt = new Date(Date.now() + ms(refreshExpiry));
    const refreshToken = crypto.randomUUID();
    await this.refreshTokens.issue({ token: refreshToken, userId, expiresAt, familyId });
    return { accessToken, refreshToken, expiresIn: 900 };
  }
}

function ms(s: string): number {
  const units: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };
  const match = /^(\d+)([smhd])$/.exec(s);
  if (!match) return 900_000;
  return parseInt(match[1]!) * (units[match[2]!] ?? 1000);
}
