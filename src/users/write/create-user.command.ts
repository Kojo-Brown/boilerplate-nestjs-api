import { Inject } from "@nestjs/common";
import { Command, CommandHandler } from "@nestjs/cqrs";
import type { ICommandHandler } from "@nestjs/cqrs";
import type { TransactionContext } from "@/common/prisma/transaction.port";
import type { User } from "@prisma/client";
import { USER_WRITER, type CreateUserData, type UserWriter } from "../ports";

/**
 * Inserts a user row.
 *
 * `tx` enrols the insert in a unit of work the *dispatcher* already opened,
 * which is a deliberate departure from orthodox CQRS — a command is supposed to
 * be a self-contained request, and this one carries a live transaction handle.
 * The alternative was worse in both directions. Registration cannot move into
 * this handler: it hashes with argon2, issues refresh tokens and stages
 * `user.registered`, none of which the users module should own. And the row and
 * that event have to commit together, or a crash between them produces either a
 * registration nobody is told about or a `user.registered` for an insert that
 * rolled back — the two failures the outbox exists to remove. So the caller
 * keeps the unit of work and passes it in. The port already accepts `tx` in the
 * same trailing position for exactly this reason.
 *
 * No eviction here: a user who did not exist a moment ago has nothing cached,
 * and the list is evicted from `user.registered` by `UsersReadModelProjector` —
 * after the transaction commits, which is the only point at which the new row
 * is visible to anyone.
 */
export class CreateUserCommand extends Command<User> {
  constructor(
    readonly data: CreateUserData,
    readonly tx?: TransactionContext,
  ) {
    super();
  }
}

@CommandHandler(CreateUserCommand)
export class CreateUserHandler implements ICommandHandler<CreateUserCommand> {
  constructor(@Inject(USER_WRITER) private readonly writer: UserWriter) {}

  execute({ data, tx }: CreateUserCommand): Promise<User> {
    return this.writer.create(data, tx);
  }
}
