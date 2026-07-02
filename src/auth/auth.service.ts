import { Injectable, UnauthorizedException, ConflictException } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { ConfigService } from "@nestjs/config";
import * as argon2 from "argon2";
import { UsersService } from "@/users/users.service";
import { PrismaService } from "@/common/prisma/prisma.service";
import type { RegisterDto } from "./dto/register.dto";
import type { LoginDto } from "./dto/login.dto";

@Injectable()
export class AuthService {
  constructor(
    private readonly users: UsersService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
  ) {}

  async register(dto: RegisterDto) {
    const exists = await this.users.findByEmail(dto.email);
    if (exists) throw new ConflictException("Email already in use");
    const hash = await argon2.hash(dto.password);
    const user = await this.users.create({ email: dto.email, password: hash, name: dto.name });
    return this.issueTokens(user.id, user.email, user.role);
  }

  async login(dto: LoginDto) {
    const user = await this.users.findByEmail(dto.email);
    if (!user?.password) throw new UnauthorizedException("Invalid credentials");
    const valid = await argon2.verify(user.password, dto.password);
    if (!valid) throw new UnauthorizedException("Invalid credentials");
    return this.issueTokens(user.id, user.email, user.role);
  }

  async refresh(token: string) {
    const stored = await this.prisma.refreshToken.findUnique({ where: { token }, include: { user: true } });
    if (!stored || stored.expiresAt < new Date()) throw new UnauthorizedException("Refresh token expired");
    await this.prisma.refreshToken.delete({ where: { id: stored.id } });
    return this.issueTokens(stored.user.id, stored.user.email, stored.user.role);
  }

  async logout(token: string): Promise<void> {
    await this.prisma.refreshToken.deleteMany({ where: { token } });
  }

  private async issueTokens(userId: string, email: string, role: string) {
    const payload = { sub: userId, email, role };
    const accessToken = this.jwt.sign(payload);
    const refreshExpiry = this.config.get("JWT_REFRESH_EXPIRY", "7d");
    const expiresAt = new Date(Date.now() + ms(refreshExpiry));
    const refreshToken = crypto.randomUUID();
    await this.prisma.refreshToken.create({ data: { token: refreshToken, userId, expiresAt } });
    return { accessToken, refreshToken, expiresIn: 900 };
  }
}

function ms(s: string): number {
  const units: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };
  const match = /^(\d+)([smhd])$/.exec(s);
  if (!match) return 900_000;
  return parseInt(match[1]!) * (units[match[2]!] ?? 1000);
}
