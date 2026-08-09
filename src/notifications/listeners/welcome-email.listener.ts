import { Injectable, Logger } from "@nestjs/common";
import { OnDomainEvent } from "@/events";
import type { DomainEvent } from "@/events";
import { EmailQueueService } from "@/queue/email/email-queue.service";

/**
 * Sends the welcome email when an account is created.
 *
 * This is the whole argument for the Observer pattern in one class.
 * `AuthService.register()` does not call it, import it, or know it exists; it
 * announces `user.registered` and returns tokens. Onboarding email is a
 * notifications concern and it lives in the notifications module, which is why
 * the dependency runs notifications → users and never back.
 *
 * The email goes onto the BullMQ queue rather than to a transport directly, so
 * a mail provider that is down delays the welcome rather than losing it, and
 * the retry ladder is the queue's rather than something reinvented here.
 * Enqueuing still involves a Redis round trip that can fail, which
 * `@OnDomainEvent` contains: a registration completes and returns tokens
 * whether or not this succeeds. That is the correct trade for a welcome email
 * and would not be for, say, provisioning the account's first workspace —
 * anything a user would notice missing belongs in the transaction, not on a
 * best-effort listener.
 */
@Injectable()
export class WelcomeEmailListener {
  private readonly logger = new Logger(WelcomeEmailListener.name);

  constructor(private readonly emails: EmailQueueService) {}

  @OnDomainEvent("user.registered")
  async onUserRegistered(event: DomainEvent<"user.registered">): Promise<void> {
    const { email, name } = event.payload;
    await this.emails.sendWelcomeEmail({ to: email, name: displayName(email, name) });
    this.logger.log(`Queued welcome email for ${email} (event ${event.id})`);
  }
}

/**
 * A name to greet the account by.
 *
 * `User.name` is nullable — an OAuth profile may not carry one and registration
 * does not require one — while the email template needs something to address
 * the reader as. The local part of the address is the least-wrong fallback:
 * it is what the user chose to call themselves somewhere, unlike a blank or a
 * literal "there", and it keeps the decision in one place rather than in a
 * template.
 */
function displayName(email: string, name: string | null): string {
  const trimmed = name?.trim();
  if (trimmed) return trimmed;
  const localPart = email.split("@")[0]?.trim();
  return localPart && localPart.length > 0 ? localPart : email;
}
