import { CreateUserHandler } from "./create-user.command";
import { DeleteUserHandler } from "./delete-user.command";
import { UpdateUserAvatarHandler } from "./update-user-avatar.command";
import { UpdateUserPreferencesHandler } from "./update-user-preferences.command";
import { UpdateUserProfileHandler } from "./update-user-profile.command";
import { UpdateUserHandler } from "./update-user.command";

export { CreateUserCommand, CreateUserHandler } from "./create-user.command";
export { UpdateUserCommand, UpdateUserHandler } from "./update-user.command";
export { UpdateUserProfileCommand, UpdateUserProfileHandler } from "./update-user-profile.command";
export { UpdateUserAvatarCommand, UpdateUserAvatarHandler } from "./update-user-avatar.command";
export type { AvatarUpload } from "./update-user-avatar.command";
export {
  UpdateUserPreferencesCommand,
  UpdateUserPreferencesHandler,
} from "./update-user-preferences.command";
export { DeleteUserCommand, DeleteUserHandler } from "./delete-user.command";
export { UserWriteModel } from "./user-write-model";

/** Every command handler, for the module's providers list. */
export const USERS_COMMAND_HANDLERS = [
  CreateUserHandler,
  UpdateUserHandler,
  UpdateUserProfileHandler,
  UpdateUserAvatarHandler,
  UpdateUserPreferencesHandler,
  DeleteUserHandler,
];
