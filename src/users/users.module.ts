import { Module } from "@nestjs/common";
import { UsersController } from "./users.controller";
import { UserAccessPolicy } from "./users.access-policy";
import { PrismaUsersRepository } from "./prisma-users.repository";
import { USER_PREFERENCES_STORE, USER_READER, USER_WRITER } from "./ports";
import { USERS_COMMAND_HANDLERS, UserWriteModel } from "./write";
import { USERS_QUERY_HANDLERS, UsersReadModelCache, UsersReadModelProjector } from "./read";
import { StorageModule } from "@/storage/storage.module";

/**
 * The users module, split by write model and read model.
 *
 * `providers` is where the split is visible: command handlers, the write
 * model's shared preconditions, query handlers, the read model's cache, and one
 * projection driven by domain events. Nothing here imports `CqrsModule` —
 * `AppCqrsModule` registers it once with `forRoot()`, which is global, and the
 * explorer finds these handlers wherever they are declared. Importing it again
 * would build a second set of buses; see `src/cqrs/cqrs.module.ts`.
 *
 * `UsersService` used to sit in the middle of all of this. It is gone rather
 * than wrapped: a service kept alongside the handlers would be a second write
 * path that the next change updates only one of.
 */
@Module({
  imports: [StorageModule],
  controllers: [UsersController],
  providers: [
    UserAccessPolicy,
    UserWriteModel,
    UsersReadModelCache,
    UsersReadModelProjector,
    ...USERS_COMMAND_HANDLERS,
    ...USERS_QUERY_HANDLERS,
    PrismaUsersRepository,
    // `useExisting`, not `useClass`: all three tokens must resolve to the same
    // instance, or each would build its own extended Prisma client. This is the
    // only place in the module that names a concrete storage implementation —
    // swapping the adapter is a three-line change here and nowhere else.
    { provide: USER_READER, useExisting: PrismaUsersRepository },
    { provide: USER_WRITER, useExisting: PrismaUsersRepository },
    { provide: USER_PREFERENCES_STORE, useExisting: PrismaUsersRepository },
  ],
  // Only the preferences token. Everything else this module can do is reached
  // by dispatching a command or a query, which needs no import edge at all —
  // `AuthModule` no longer imports this one. `NotificationDispatcher` depends on
  // the port rather than on a service, so exporting the symbol keeps that
  // inversion intact across the module boundary; the concrete repository stays
  // private.
  exports: [USER_PREFERENCES_STORE],
})
export class UsersModule {}
