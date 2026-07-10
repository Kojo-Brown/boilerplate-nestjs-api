import { ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { UsersRepository } from "./users.repository";
import { CacheService } from "@/common/cache";
import { buildCursorPage, decodeCursor } from "@/common/pagination";
import type { CursorPage } from "@/common/pagination";
import type { User } from "@prisma/client";
import type { UpdateUserDto } from "./dto/update-user.dto";
import type { ListUsersQueryDto } from "./dto/list-users-query.dto";
import type { UserPreferences } from "./types/user-preferences";
import type { UpdateUserPreferencesDto } from "./dto/update-user-preferences.dto";

export const USERS_LIST_CACHE_KEY = "v1:users:list";
export const userCacheKey = (id: string) => `v1:users:${id}`;

@Injectable()
export class UsersService {
  constructor(
    private readonly repo: UsersRepository,
    private readonly cache: CacheService,
  ) {}

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
    const updated = await this.repo.update(id, data);
    await this.invalidateUserCache(id);
    return updated;
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
    const updated = await this.repo.update(targetId, dto);
    await this.invalidateUserCache(targetId);
    return updated;
  }

  async updateAvatar(id: string, avatarUrl: string): Promise<User> {
    await this.findById(id);
    const updated = await this.repo.update(id, { avatarUrl });
    await this.invalidateUserCache(id);
    return updated;
  }

  async remove(id: string): Promise<void> {
    await this.findById(id);
    await this.repo.delete(id);
    await this.invalidateUserCache(id);
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
    const prefs = await this.repo.setPreferences(userId, dto);
    await this.cache.del(`${userCacheKey(userId)}:prefs`);
    return prefs;
  }

  private invalidateUserCache(id: string): Promise<void> {
    return this.cache.delMany([userCacheKey(id), USERS_LIST_CACHE_KEY]);
  }
}
