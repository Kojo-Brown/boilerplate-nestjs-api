import { ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { UsersRepository } from "./users.repository";
import { buildCursorPage, decodeCursor } from "@/common/pagination";
import type { CursorPage } from "@/common/pagination";
import type { User } from "@prisma/client";
import type { UpdateUserDto } from "./dto/update-user.dto";
import type { ListUsersQueryDto } from "./dto/list-users-query.dto";
import type { UserPreferences } from "./types/user-preferences";
import type { UpdateUserPreferencesDto } from "./dto/update-user-preferences.dto";

@Injectable()
export class UsersService {
  constructor(private readonly repo: UsersRepository) {}

  async findById(id: string): Promise<User> {
    const user = await this.repo.findById(id);
    if (!user) throw new NotFoundException(`User ${id} not found`);
    return user;
  }

  findByEmail(email: string): Promise<User | null> {
    return this.repo.findByEmail(email);
  }

  findByProviderAccount(provider: string, providerAccountId: string): Promise<User | null> {
    return this.repo.findByProviderAccount(provider, providerAccountId);
  }

  async listUsers(query: ListUsersQueryDto): Promise<CursorPage<User>> {
    const cursor = query.cursor ? decodeCursor(query.cursor) : undefined;
    const rows = await this.repo.findMany({ cursor, limit: query.limit, search: query.search });
    return buildCursorPage(rows, query.limit);
  }

  create(data: {
    email: string;
    password?: string;
    name?: string;
    provider?: string;
    providerAccountId?: string;
  }): Promise<User> {
    return this.repo.create(data);
  }

  async update(
    id: string,
    data: { name?: string; provider?: string; providerAccountId?: string },
  ): Promise<User> {
    await this.findById(id);
    return this.repo.update(id, data);
  }

  async updateSelf(
    requesterId: string,
    targetId: string,
    dto: UpdateUserDto,
    requesterRole: string,
  ): Promise<User> {
    if (requesterId !== targetId && requesterRole !== "ADMIN") {
      throw new ForbiddenException("Cannot modify another user's profile");
    }
    await this.findById(targetId);
    return this.repo.update(targetId, dto);
  }

  async updateAvatar(id: string, avatarUrl: string): Promise<User> {
    await this.findById(id);
    return this.repo.update(id, { avatarUrl });
  }

  async remove(id: string): Promise<void> {
    await this.findById(id);
    await this.repo.delete(id);
  }

  async getPreferences(
    userId: string,
    requesterId: string,
    requesterRole: string,
  ): Promise<UserPreferences> {
    if (requesterId !== userId && requesterRole !== "ADMIN") {
      throw new ForbiddenException("Cannot read another user's preferences");
    }
    await this.findById(userId);
    return this.repo.getPreferences(userId);
  }

  async updatePreferences(
    userId: string,
    requesterId: string,
    requesterRole: string,
    dto: UpdateUserPreferencesDto,
  ): Promise<UserPreferences> {
    if (requesterId !== userId && requesterRole !== "ADMIN") {
      throw new ForbiddenException("Cannot modify another user's preferences");
    }
    await this.findById(userId);
    return this.repo.setPreferences(userId, dto);
  }
}
