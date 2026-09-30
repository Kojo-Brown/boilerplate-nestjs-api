import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Role } from "@prisma/client";
import type { User } from "@prisma/client";

/**
 * A user as it goes on the wire.
 *
 * Every field here is one somebody decided to publish. That is not a comment on
 * the class, it is the contract {@link toUserResponse} enforces: the row this
 * shape is built from carries `password` — an argon2 hash — and
 * `providerAccountId`, the identifier Google knows the account by, and neither
 * has any business leaving the process.
 *
 * `preferences` is deliberately absent. It was on this class, and every profile
 * response carried it, which quietly undid the ownership check on
 * `GET /users/:id/preferences`: that endpoint answers 403 for somebody else's
 * preferences while `GET /users/:id` handed the same object to any
 * authenticated caller. Preferences are served by the endpoint that guards
 * them, and by that endpoint only.
 */
export class UserResponseDto {
  @ApiProperty({ example: "clxxxxxxxxxxxxxxxx" })
  readonly id!: string;

  @ApiProperty({ example: "jane@example.com" })
  readonly email!: string;

  @ApiPropertyOptional({ example: "Jane Doe", nullable: true })
  readonly name!: string | null;

  @ApiProperty({ enum: Role, example: Role.USER })
  readonly role!: Role;

  @ApiPropertyOptional({ example: "google", nullable: true })
  readonly provider!: string | null;

  @ApiPropertyOptional({ example: "avatars/user-1/1234567890.jpg", nullable: true })
  readonly avatarUrl!: string | null;

  @ApiProperty({ example: "2024-01-01T00:00:00.000Z" })
  readonly createdAt!: Date;

  @ApiProperty({ example: "2024-01-01T00:00:00.000Z" })
  readonly updatedAt!: Date;

  @ApiProperty({
    example: 3,
    description:
      "Optimistic-concurrency version. Also returned as the `ETag` header, which is the form to send back in `If-Match`.",
  })
  readonly version!: number;
}

/**
 * Shapes a user row for the wire.
 *
 * Hand-written rather than a `class-transformer` pass, for the reason
 * `toOrderResponse` is: what leaves the process is decided by a list somebody
 * wrote, not by which columns happen to be on the row. The users resource was
 * the one place in this repository that did not do this — its four
 * user-returning endpoints returned the Prisma row straight through — and the
 * result was that `GET /v1/users/:id` answered any authenticated caller with
 * the target's argon2 password hash. `UserResponseDto` had documented the
 * narrower shape all along; nothing enforced it.
 *
 * An allowlist rather than a `delete user.password`: a denylist is only correct
 * until the next column is added, and the next column is added by somebody who
 * has never read this file.
 */
export function toUserResponse(user: User): UserResponseDto {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    provider: user.provider,
    avatarUrl: user.avatarUrl,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
    version: user.version,
  };
}
