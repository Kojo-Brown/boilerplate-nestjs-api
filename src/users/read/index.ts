import { FindUserByEmailHandler, FindUserByProviderAccountHandler } from "./find-user.query";
import { GetUserPreferencesHandler } from "./get-user-preferences.query";
import { GetUserHandler } from "./get-user.query";
import { ListUsersHandler } from "./list-users.query";

export { GetUserHandler, GetUserQuery } from "./get-user.query";
export { ListUsersHandler, ListUsersQuery } from "./list-users.query";
export {
  FindUserByEmailHandler,
  FindUserByEmailQuery,
  FindUserByProviderAccountHandler,
  FindUserByProviderAccountQuery,
} from "./find-user.query";
export { GetUserPreferencesHandler, GetUserPreferencesQuery } from "./get-user-preferences.query";
export { UsersReadModelProjector } from "./users-read-model.projector";
export {
  USERS_LIST_CACHE_KEY,
  UsersReadModelCache,
  userCacheKey,
  userPreferencesCacheKey,
} from "./users-read-model.cache";

/** Every query handler, for the module's providers list. */
export const USERS_QUERY_HANDLERS = [
  GetUserHandler,
  ListUsersHandler,
  FindUserByEmailHandler,
  FindUserByProviderAccountHandler,
  GetUserPreferencesHandler,
];
