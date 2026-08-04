import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { CacheService } from "@/common/cache";
import { buildCursorPage, decodeCursor } from "@/common/pagination";
import type { CursorPage } from "@/common/pagination";
import type { User } from "@prisma/client";
import {
  USER_PREFERENCES_STORE,
  USER_READER,
  USER_WRITER,
  type CreateUserData,
  type UpdateUserData,
  type UserPreferencesStore,
  type UserReader,
  type UserWriter,
} from "./ports";
import { UserAccessPolicy, type RequesterIdentity } from "./users.access-policy";
import type { UpdateUserDto } from "./dto/update-user.dto";
import type { ListUsersQueryDto } from "./dto/list-users-query.dto";
import type { UserPreferences } from "./types/user-preferences";
import type { UpdateUserPreferencesDto } from "./dto/update-user-preferences.dto";

export const USERS_LIST_CACHE_KEY = "v1:users:list";
export const userCacheKey = (id: string) => `v1:users:${id}`;

/**
 * Application service for the users module.
 *
 * Depends on the three storage ports rather than on a concrete repository
 * (DIP) and on `UserAccessPolicy` for ownership decisions (SRP). Nothing here
 * knows that the store is Prisma, which is why the contract-tested in-memory
 * implementation can be dropped in unchanged.
 */
@Injectable()
export class UsersService {
  constructor(
    @Inject(USER_READER) private readonly reader: UserReader,
    @Inject(USER_WRITER) private readonly writer: UserWriter,
    @Inject(USER_PREFERENCES_STORE) private readonly preferences: UserPreferencesStore,
    private readonly cache: CacheService,
    private readonly policy: UserAccessPolicy,
  ) {}

  async findById(id: string): Promise<User> {
    const user = await this.reader.findById(id);
    if (!user) throw new NotFoundException(`User ${id} not found`);
    return user;
  }

  findByEmail(email: string): Promise<User | null> {
    return this.reader.findByEmail(email);
  }

  findByProviderAccount(provider: string, providerAccountId: string): Promise<User | null> {
    return this.reader.findByProviderAccount(provider, providerAccountId);
  }

  async listUsers(query: ListUsersQueryDto): Promise<CursorPage<User>> {
    const cursor = query.cursor ? decodeCursor(query.cursor) : undefined;
    const rows = await this.reader.findMany({
      cursor,
      limit: query.limit,
      search: query.search,
    });
    return buildCursorPage(rows, query.limit);
  }

  create(data: CreateUserData): Promise<User> {
    return this.writer.create(data);
  }

  /** Unconditional update — callers that act on behalf of a user use {@link updateSelf}. */
  async update(id: string, data: UpdateUserData): Promise<User> {
    await this.findById(id);
    const updated = await this.writer.update(id, data);
    await this.invalidateUserCache(id);
    return updated;
  }

  async updateSelf(
    requester: RequesterIdentity,
    targetId: string,
    dto: UpdateUserDto,
  ): Promise<User> {
    this.policy.assertCanAct(requester, targetId, "update:profile");
    return this.update(targetId, dto);
  }

  async updateAvatar(id: string, avatarUrl: string): Promise<User> {
    return this.update(id, { avatarUrl });
  }

  async remove(id: string): Promise<void> {
    await this.findById(id);
    await this.writer.delete(id);
    await this.invalidateUserCache(id);
  }

  async getPreferences(requester: RequesterIdentity, userId: string): Promise<UserPreferences> {
    this.policy.assertCanAct(requester, userId, "read:preferences");
    await this.findById(userId);
    return this.preferences.getPreferences(userId);
  }

  async updatePreferences(
    requester: RequesterIdentity,
    userId: string,
    dto: UpdateUserPreferencesDto,
  ): Promise<UserPreferences> {
    this.policy.assertCanAct(requester, userId, "update:preferences");
    await this.findById(userId);
    const prefs = await this.preferences.setPreferences(userId, dto);
    await this.cache.del(`${userCacheKey(userId)}:prefs`);
    return prefs;
  }

  private invalidateUserCache(id: string): Promise<void> {
    return this.cache.delMany([userCacheKey(id), USERS_LIST_CACHE_KEY]);
  }
}
