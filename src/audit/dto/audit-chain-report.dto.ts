import { ApiProperty } from "@nestjs/swagger";
import type {
  AuditChainBreach,
  AuditChainBreachKind,
  AuditChainReport,
} from "../audit-chain.verifier";

export class AuditChainBreachDto {
  @ApiProperty({
    description: "Where the chain stops adding up, as a decimal string.",
    example: "7",
  })
  readonly seq!: string;

  @ApiProperty({
    description:
      "wrong-genesis: entries are missing from the front. gap: an entry was deleted. " +
      "broken-link: an entry no longer names its predecessor. forged-hash: an entry's " +
      "contents were changed after it was written.",
    enum: ["wrong-genesis", "gap", "broken-link", "forged-hash"],
  })
  readonly kind!: AuditChainBreachKind;

  @ApiProperty({ example: "Entry 7 is missing: 6 is followed by 8." })
  readonly detail!: string;

  static from(breach: AuditChainBreach): AuditChainBreachDto {
    return { seq: breach.seq.toString(), kind: breach.kind, detail: breach.detail };
  }
}

export class AuditChainReportDto {
  @ApiProperty({ description: "Whether every entry checked out." })
  readonly intact!: boolean;

  @ApiProperty({ description: "How many entries were verified before stopping." })
  readonly checked!: number;

  @ApiProperty({ nullable: true, example: "1" })
  readonly firstSeq!: string | null;

  @ApiProperty({ nullable: true, example: "1024" })
  readonly lastSeq!: string | null;

  @ApiProperty({
    description:
      "The last verified entry's hash — the whole chain's fingerprint. Record it somewhere " +
      "outside this service: it pins every entry written before it.",
    nullable: true,
  })
  readonly headHash!: string | null;

  @ApiProperty({ type: AuditChainBreachDto, nullable: true })
  readonly breach!: AuditChainBreachDto | null;

  static from(report: AuditChainReport): AuditChainReportDto {
    return {
      intact: report.intact,
      checked: report.checked,
      firstSeq: report.firstSeq?.toString() ?? null,
      lastSeq: report.lastSeq?.toString() ?? null,
      headHash: report.headHash,
      breach: report.breach ? AuditChainBreachDto.from(report.breach) : null,
    };
  }
}
