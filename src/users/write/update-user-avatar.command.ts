import { Command, CommandHandler } from "@nestjs/cqrs";
import type { ICommandHandler } from "@nestjs/cqrs";
import type { ExpectedVersion } from "@/common/concurrency";
import { StorageService } from "@/storage/storage.service";
import type { User } from "@prisma/client";
import { UserAccessPolicy, type RequesterIdentity } from "../users.access-policy";
import { UserWriteModel } from "./user-write-model";

/**
 * The bytes and the two facts about them this command needs.
 *
 * Declared here rather than taking `Express.Multer.File`, which an
 * `Express.Multer.File` still satisfies structurally: the write model has no
 * business depending on the HTTP layer's upload representation, and a handler
 * typed against it could not be driven from a queue consumer or a test without
 * inventing eleven fields nothing reads.
 */
export interface AvatarUpload {
  readonly buffer: Buffer;
  readonly originalname: string;
  readonly mimetype: string;
}

/** Replaces a user's avatar with an uploaded image. */
export class UpdateUserAvatarCommand extends Command<User> {
  constructor(
    readonly requester: RequesterIdentity,
    readonly targetId: string,
    readonly file: AvatarUpload,
    readonly expected: ExpectedVersion,
  ) {
    super();
  }
}

@CommandHandler(UpdateUserAvatarCommand)
export class UpdateUserAvatarHandler implements ICommandHandler<UpdateUserAvatarCommand> {
  constructor(
    private readonly users: UserWriteModel,
    private readonly storage: StorageService,
    private readonly policy: UserAccessPolicy,
  ) {}

  /**
   * Both checks run before a byte is uploaded, and that ordering is the reason
   * this whole flow is one command rather than an upload in the controller
   * followed by a write.
   *
   * Ownership first, so a forbidden request never reaches S3 at all. Then the
   * precondition, so a request that has already lost a race does not leave a
   * 5 MB object in the bucket that nothing will ever reference. Neither check
   * makes the write safe — the row can still move between here and the update,
   * which is what the conditional write below is for — they only keep the
   * common conflict from costing an upload.
   *
   * The object key is minted here for the same reason: it is part of what the
   * write means, and a caller that chose its own could overwrite another user's
   * object by naming it.
   */
  async execute({ requester, targetId, file, expected }: UpdateUserAvatarCommand): Promise<User> {
    this.policy.assertCanAct(requester, targetId, "update:avatar");
    await this.users.assertPrecondition(targetId, expected);

    const extension = (file.originalname.split(".").pop() ?? "bin").toLowerCase();
    const key = `avatars/${targetId}/${Date.now()}.${extension}`;
    await this.storage.uploadBuffer(key, file.buffer, file.mimetype);

    // The key, not a URL: the column holds an object key and the presigned URL
    // is derived at read time, so a bucket or CDN move does not rewrite rows.
    return this.users.applyUpdate(targetId, { avatarUrl: key }, expected);
  }
}
