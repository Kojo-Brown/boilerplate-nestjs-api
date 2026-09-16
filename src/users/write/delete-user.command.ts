import { Inject } from "@nestjs/common";
import { Command, CommandHandler } from "@nestjs/cqrs";
import type { ICommandHandler } from "@nestjs/cqrs";
import { AuditLog, type AuditActor } from "@/audit";
import type { ExpectedVersion } from "@/common/concurrency";
import { TRANSACTION_RUNNER } from "@/common/prisma/transaction.port";
import type { TransactionRunner } from "@/common/prisma/transaction.port";
import { TransactionalOutbox } from "@/outbox";
import { USER_WRITER, type UserWriter } from "../ports";
import { UsersReadModelCache } from "../read/users-read-model.cache";
import { UserWriteModel } from "./user-write-model";

/** Deletes a user and announces it, atomically. Admin-only at the HTTP edge. */
export class DeleteUserCommand extends Command<void> {
  constructor(
    readonly id: string,
    readonly expected: ExpectedVersion,
    /**
     * The admin doing the deleting, for the audit entry.
     *
     * On the command rather than read from the request inside the handler: a
     * command is meant to be dispatchable from anywhere — a console script, a
     * saga step, a future admin CLI — and a handler that reaches for an HTTP
     * request would work in exactly one of those places. `null` is the
     * available, honest answer for the callers that genuinely are the system.
     */
    readonly actor: AuditActor | null,
  ) {
    super();
  }
}

@CommandHandler(DeleteUserCommand)
export class DeleteUserHandler implements ICommandHandler<DeleteUserCommand> {
  constructor(
    private readonly users: UserWriteModel,
    @Inject(USER_WRITER) private readonly writer: UserWriter,
    private readonly cache: UsersReadModelCache,
    @Inject(TRANSACTION_RUNNER) private readonly transactions: TransactionRunner,
    private readonly outbox: TransactionalOutbox,
    private readonly audit: AuditLog,
  ) {}

  /**
   * The event is staged in the same transaction as the delete rather than
   * published after it, so the two outcomes a bare emitter allows are gone: a
   * user deleted with nobody told, and a `user.deleted` describing a row that
   * is still there because the delete rolled back.
   *
   * The cache is invalidated *inside* the unit of work, which is not where it
   * belongs on first reading. It is deliberate: the relay may publish the
   * moment the transaction commits, and a subscriber reading back through the
   * query side must not find the deleted row still cached. Invalidating early
   * is safe in the other direction — a transaction that then rolls back leaves
   * the cache merely cold, and the next read repopulates it from a row that
   * does still exist.
   *
   * This is also why the eviction is not left to `UsersReadModelProjector`,
   * which sees the same event: the projector runs after the commit *and* after
   * a relay poll, and a read in that window would be served the deleted user.
   * The projector's copy of the eviction is for the replicas that did not serve
   * this request.
   */
  async execute({ id, expected, actor }: DeleteUserCommand): Promise<void> {
    const user = await this.users.assertPrecondition(id, expected);
    await this.transactions.run(async (tx) => {
      await this.users.conditionally(() => this.writer.delete(id, expected, tx));
      await this.cache.evictUser(id);
      // The address travels on the event because nothing can look it up once
      // this commits.
      await this.outbox.stage(tx, "user.deleted", { userId: id, email: user.email });
      // And it is recorded, for the same reason and one more. A deletion is the
      // operation an audit log exists for: it is the one that destroys the
      // evidence of itself, so the record of *who* did it has to be written by
      // the same commit that does it — and has to survive in a table that
      // neither the deleted user's cascade nor anything else can reach.
      //
      // Last in the unit of work, because the append holds a global advisory
      // lock until it commits. See `PrismaAuditLogStore`.
      await this.audit.record(tx, "user.deleted", id, { email: user.email }, { actor });
    });
  }
}
