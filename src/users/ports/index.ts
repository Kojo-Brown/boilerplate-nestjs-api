export { USER_READER } from "./user-reader.port";
export type { UserReader, UserListQuery } from "./user-reader.port";

export { USER_WRITER } from "./user-writer.port";
export type { UserWriter, CreateUserData, UpdateUserData } from "./user-writer.port";

export { USER_PREFERENCES_STORE } from "./user-preferences-store.port";
export type { UserPreferencesStore } from "./user-preferences-store.port";

import type { UserReader } from "./user-reader.port";
import type { UserWriter } from "./user-writer.port";
import type { UserPreferencesStore } from "./user-preferences-store.port";

/**
 * The three ports together.
 *
 * Only the storage adapter and the contract suite use this: it is the shape an
 * implementation must satisfy to be bound to all three tokens at once. No
 * consumer should depend on it — depending on the union is exactly the fat
 * interface the split removed.
 */
export type UsersStore = UserReader & UserWriter & UserPreferencesStore;
