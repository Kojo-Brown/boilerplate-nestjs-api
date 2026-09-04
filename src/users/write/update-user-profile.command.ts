import { Command, CommandHandler } from "@nestjs/cqrs";
import type { ICommandHandler } from "@nestjs/cqrs";
import type { ExpectedVersion } from "@/common/concurrency";
import type { User } from "@prisma/client";
import type { UpdateUserDto } from "../dto/update-user.dto";
import { UserAccessPolicy, type RequesterIdentity } from "../users.access-policy";
import { UserWriteModel } from "./user-write-model";

/** A client editing a profile — their own, or anyone's if they are an admin. */
export class UpdateUserProfileCommand extends Command<User> {
  constructor(
    readonly requester: RequesterIdentity,
    readonly targetId: string,
    readonly dto: UpdateUserDto,
    readonly expected: ExpectedVersion,
  ) {
    super();
  }
}

@CommandHandler(UpdateUserProfileCommand)
export class UpdateUserProfileHandler implements ICommandHandler<UpdateUserProfileCommand> {
  constructor(
    private readonly users: UserWriteModel,
    private readonly policy: UserAccessPolicy,
  ) {}

  /**
   * Ownership first, precondition second. A stranger who sends no `If-Match`
   * must be told 403 and not 428: the second answer describes how to retry a
   * request they were never going to be allowed to make, and tells them the
   * user exists into the bargain.
   */
  async execute({ requester, targetId, dto, expected }: UpdateUserProfileCommand): Promise<User> {
    this.policy.assertCanAct(requester, targetId, "update:profile");
    await this.users.assertPrecondition(targetId, expected);
    return this.users.applyUpdate(targetId, dto, expected);
  }
}
