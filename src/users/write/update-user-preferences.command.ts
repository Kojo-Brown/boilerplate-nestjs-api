import { Inject } from "@nestjs/common";
import { Command, CommandHandler } from "@nestjs/cqrs";
import type { ICommandHandler } from "@nestjs/cqrs";
import type { ExpectedVersion } from "@/common/concurrency";
import {
  USER_PREFERENCES_STORE,
  type PreferencesWriteResult,
  type UserPreferencesStore,
} from "../ports";
import { UsersReadModelCache } from "../read/users-read-model.cache";
import { UserAccessPolicy, type RequesterIdentity } from "../users.access-policy";
import type { UpdateUserPreferencesDto } from "../dto/update-user-preferences.dto";
import { UserWriteModel } from "./user-write-model";

/** Merges a patch into a user's stored preferences. */
export class UpdateUserPreferencesCommand extends Command<PreferencesWriteResult> {
  constructor(
    readonly requester: RequesterIdentity,
    readonly userId: string,
    readonly dto: UpdateUserPreferencesDto,
    readonly expected: ExpectedVersion,
  ) {
    super();
  }
}

@CommandHandler(UpdateUserPreferencesCommand)
export class UpdateUserPreferencesHandler implements ICommandHandler<UpdateUserPreferencesCommand> {
  constructor(
    private readonly users: UserWriteModel,
    @Inject(USER_PREFERENCES_STORE) private readonly preferences: UserPreferencesStore,
    private readonly cache: UsersReadModelCache,
    private readonly policy: UserAccessPolicy,
  ) {}

  /**
   * Two evictions, and both are needed. The preferences entry is the obvious
   * one; the user entry is not, until you notice that preferences live on the
   * user row — so writing them moves that row's version, and the cached user
   * representation is now serving an `ETag` for a version that has been
   * superseded. A client that reads the user, edits it and writes inside the
   * TTL would be refused with 412 against a version that no longer exists.
   */
  async execute({
    requester,
    userId,
    dto,
    expected,
  }: UpdateUserPreferencesCommand): Promise<PreferencesWriteResult> {
    this.policy.assertCanAct(requester, userId, "update:preferences");
    await this.users.assertPrecondition(userId, expected);
    const written = await this.users.conditionally(() =>
      this.preferences.setPreferences(userId, dto, expected),
    );
    await this.cache.evictPreferences(userId);
    await this.cache.evictUser(userId);
    return written;
  }
}
