import { Logger } from "@nestjs/common";
import { EventsHandler } from "@nestjs/cqrs";
import type { IEventHandler } from "@nestjs/cqrs";
import { UserDeletedEvent, UserRegisteredEvent } from "@/cqrs";
import { UsersReadModelCache } from "./users-read-model.cache";

/**
 * Keeps the users read model honest about changes no write path can announce
 * to it.
 *
 * There are two of those, and only two, which is why this handler is small.
 *
 * **A registration.** `AuthService` creates the row — it owns the password
 * hashing and the token issue, so the users module cannot own that write — and
 * it has no business knowing that the admin list endpoint caches its first page
 * for sixty seconds. Before this handler nothing evicted that key on a
 * registration, so a newly registered user was missing from `GET /v1/users` for
 * up to a minute, with no bug report possible because the list was not wrong,
 * only old. The event is the seam: the write side says a user now exists and
 * the read side decides that its list is stale.
 *
 * **A deletion that happened somewhere else.** `DeleteUserHandler` evicts
 * synchronously inside its own transaction, so on the replica that served the
 * delete this is a redundant second eviction — deliberately, because eviction
 * is idempotent and the alternative is a handler that has to know which replica
 * it is. It stops being redundant the moment there is more than one process:
 * `DomainEventConsumer` puts what it reads off the broker onto the same bus, so
 * a delete served by another instance arrives here indistinguishably from a
 * local one. That matters whenever the cache is per-process, which is the
 * configuration `AppCacheModule` falls back to with no `REDIS_URL` set.
 *
 * Losing one of these evictions costs a stale entry until its TTL expires,
 * which is why this work is allowed on the CQRS event bus at all — see
 * `DomainEventCqrsBridge` for what is not.
 */
@EventsHandler(UserRegisteredEvent, UserDeletedEvent)
export class UsersReadModelProjector implements IEventHandler<
  UserRegisteredEvent | UserDeletedEvent
> {
  private readonly logger = new Logger(UsersReadModelProjector.name);

  constructor(private readonly cache: UsersReadModelCache) {}

  async handle(event: UserRegisteredEvent | UserDeletedEvent): Promise<void> {
    if (event instanceof UserRegisteredEvent) {
      // Only the list: there is no cached representation of a user who has
      // just come into existence, and creating one here would cache a row
      // nobody has asked for.
      await this.cache.evictList();
      this.logger.debug(`Evicted the users list after ${event.name} (${event.id})`);
      return;
    }

    await this.cache.evictUser(event.payload.userId);
    this.logger.debug(`Evicted user ${event.payload.userId} after ${event.name} (${event.id})`);
  }
}
