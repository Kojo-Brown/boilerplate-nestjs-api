import { ApiProperty } from "@nestjs/swagger";
import type { AuditEntry } from "../audit-entry";

/**
 * One entry, as it leaves over HTTP.
 *
 * `seq` is a string here and a `bigint` everywhere behind it. That is not a
 * style choice: `JSON.stringify` throws on a `BigInt` rather than coercing it,
 * so the envelope interceptor would turn every response into a 500 — and the
 * obvious repair, `Number(seq)`, silently rounds past 2^53 in a column that is
 * `BIGINT` precisely because it is expected to get large. A decimal string is
 * the one representation that survives JSON intact, and it is what a client
 * hands back as `afterSeq`.
 *
 * `prevHash` and `hash` are exposed deliberately. A caller who has stored a
 * previous head hash can re-verify the chain independently from these
 * responses, which is the whole point of publishing the head somewhere this
 * service cannot reach.
 */
export class AuditEntryResponseDto {
  @ApiProperty({
    description: "Position in the chain, as a decimal string (the column is a 64-bit integer).",
    example: "42",
  })
  readonly seq!: string;

  @ApiProperty({ description: "When the audited action happened.", format: "date-time" })
  readonly occurredAt!: string;

  @ApiProperty({ description: "What was done.", example: "user.deleted" })
  readonly action!: string;

  @ApiProperty({ description: "What it was done to.", example: "user" })
  readonly resourceType!: string;

  @ApiProperty({ example: "clxxxxxxxxxxxxxxxx" })
  readonly resourceId!: string;

  @ApiProperty({
    description: "Everything else recorded with the action.",
    type: "object",
    additionalProperties: true,
    example: { email: "deleted@example.com" },
  })
  readonly details!: unknown;

  @ApiProperty({
    description: "Who did it. Null means the system did.",
    nullable: true,
    example: "clyyyyyyyyyyyyyyyy",
  })
  readonly actorId!: string | null;

  @ApiProperty({
    description: "The role the actor held at the time, not the one they hold now.",
    nullable: true,
    example: "ADMIN",
  })
  readonly actorRole!: string | null;

  @ApiProperty({ nullable: true, example: "3f1c2c8e-1f6e-4f1a-9c1d-0d6f2f7b7a11" })
  readonly correlationId!: string | null;

  @ApiProperty({ description: "The previous entry's hash.", example: "0".repeat(64) })
  readonly prevHash!: string;

  @ApiProperty({ description: "SHA-256 over this entry and prevHash, hex.", example: "9f86d0…" })
  readonly hash!: string;

  static from(entry: AuditEntry): AuditEntryResponseDto {
    return {
      seq: entry.seq.toString(),
      occurredAt: entry.occurredAt.toISOString(),
      action: entry.action,
      resourceType: entry.resourceType,
      resourceId: entry.resourceId,
      details: entry.details,
      actorId: entry.actorId,
      actorRole: entry.actorRole,
      correlationId: entry.correlationId,
      prevHash: entry.prevHash,
      hash: entry.hash,
    };
  }
}
