import { Inject } from "@nestjs/common";
import { Query, QueryHandler } from "@nestjs/cqrs";
import type { IQueryHandler } from "@nestjs/cqrs";
import {
  USER_PREFERENCES_STORE,
  USER_READER,
  type PreferencesWriteResult,
  type UserPreferencesStore,
  type UserReader,
} from "../ports";
import { requireUser } from "../require-user";
import { UserAccessPolicy, type RequesterIdentity } from "../users.access-policy";

/**
 * A user's preferences, with the version to write them back against.
 *
 * A query that enforces ownership, which looks like policy leaking onto the
 * read side and is not: "may this principal see this row" is a property of the
 * read, and pushing it up into the controller is how the same check ends up
 * copied into every endpoint that touches the resource — which is where it was
 * before `UserAccessPolicy` existed.
 */
export class GetUserPreferencesQuery extends Query<PreferencesWriteResult> {
  constructor(
    readonly requester: RequesterIdentity,
    readonly userId: string,
  ) {
    super();
  }
}

@QueryHandler(GetUserPreferencesQuery)
export class GetUserPreferencesHandler implements IQueryHandler<GetUserPreferencesQuery> {
  constructor(
    @Inject(USER_READER) private readonly reader: UserReader,
    @Inject(USER_PREFERENCES_STORE) private readonly preferences: UserPreferencesStore,
    private readonly policy: UserAccessPolicy,
  ) {}

  /**
   * The version comes from the user row, not from the preferences store, which
   * has none of its own: preferences are a projection of a JSON column on that
   * row, and the row's counter is the only thing that moves when they change.
   * Reading the row also supplies the 404 the store deliberately does not —
   * `getPreferences` answers with defaults for an unknown id.
   */
  async execute({ requester, userId }: GetUserPreferencesQuery): Promise<PreferencesWriteResult> {
    this.policy.assertCanAct(requester, userId, "read:preferences");
    const user = await requireUser(this.reader, userId);
    const preferences = await this.preferences.getPreferences(userId);
    return { preferences, version: user.version };
  }
}
