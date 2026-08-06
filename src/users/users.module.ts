import { Module } from "@nestjs/common";
import { UsersService } from "./users.service";
import { UsersController } from "./users.controller";
import { UserAccessPolicy } from "./users.access-policy";
import { PrismaUsersRepository } from "./prisma-users.repository";
import { USER_PREFERENCES_STORE, USER_READER, USER_WRITER } from "./ports";
import { StorageModule } from "@/storage/storage.module";

@Module({
  imports: [StorageModule],
  controllers: [UsersController],
  providers: [
    UsersService,
    UserAccessPolicy,
    PrismaUsersRepository,
    // `useExisting`, not `useClass`: all three tokens must resolve to the same
    // instance, or each would build its own extended Prisma client. This is the
    // only place in the module that names a concrete storage implementation —
    // swapping the adapter is a three-line change here and nowhere else.
    { provide: USER_READER, useExisting: PrismaUsersRepository },
    { provide: USER_WRITER, useExisting: PrismaUsersRepository },
    { provide: USER_PREFERENCES_STORE, useExisting: PrismaUsersRepository },
  ],
  // The preferences token as well as the service: `NotificationDispatcher`
  // depends on the port, not on `UsersService`, so exporting the symbol keeps
  // that inversion intact across the module boundary. The concrete repository
  // stays private.
  exports: [UsersService, USER_PREFERENCES_STORE],
})
export class UsersModule {}
