import { Command, CommandHandler } from "@nestjs/cqrs";
import type { ICommandHandler } from "@nestjs/cqrs";
import type { ExpectedVersion } from "@/common/concurrency";
import type { User } from "@prisma/client";
import type { UpdateUserData } from "../ports";
import { UserWriteModel } from "./user-write-model";

/**
 * Writes fields on a user row on behalf of the system rather than a client.
 *
 * The one caller is the OAuth link path, which attaches a Google identity to an
 * account that already exists. It passes `UNCONDITIONAL` and says so at the
 * call site: there is no version the caller could have been holding, because no
 * client read a representation and proposed an edit to it, and refusing the
 * link because an unrelated field moved would strand the sign-in.
 *
 * That is why this command exists alongside `UpdateUserProfileCommand` instead
 * of being the same one with an optional requester. A command whose
 * authorisation is "there is no requester" is a different request from one a
 * user made, and collapsing them means the check that a client must name a
 * version becomes conditional on a field being present — the shape of mistake
 * that reopens a lost-update window silently.
 */
export class UpdateUserCommand extends Command<User> {
  constructor(
    readonly id: string,
    readonly data: UpdateUserData,
    readonly expected: ExpectedVersion,
  ) {
    super();
  }
}

@CommandHandler(UpdateUserCommand)
export class UpdateUserHandler implements ICommandHandler<UpdateUserCommand> {
  constructor(private readonly users: UserWriteModel) {}

  async execute({ id, data, expected }: UpdateUserCommand): Promise<User> {
    // 404 before the write, so a missing user is reported as such rather than
    // as whatever the storage adapter raises for an update that matched no row.
    await this.users.require(id);
    return this.users.applyUpdate(id, data, expected);
  }
}
