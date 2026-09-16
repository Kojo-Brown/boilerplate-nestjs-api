import { Controller, Get, Inject, Query, UseGuards } from "@nestjs/common";
import { ApiOkResponse, ApiOperation, ApiTags } from "@nestjs/swagger";
import { JwtAuthGuard } from "@/auth/guards/jwt-auth.guard";
import { RolesGuard } from "@/auth/guards/roles.guard";
import { Roles } from "@/common/decorators/roles.decorator";
import { ApiJwtAuth } from "@/common/swagger/api-jwt-auth.decorator";
import { ApiCommonErrors, ApiForbiddenRole } from "@/common/swagger/api-error-responses.decorator";
import { ApiEnvelopeOf } from "@/common/dto/response-envelope.dto";
import { AuditChainVerifier } from "./audit-chain.verifier";
import { AUDIT_LOG_STORE, type AuditLogStore } from "./ports";
import { AuditChainReportDto } from "./dto/audit-chain-report.dto";
import { AuditEntryResponseDto } from "./dto/audit-entry-response.dto";
import { ListAuditLogQueryDto } from "./dto/list-audit-log-query.dto";

/**
 * Reading the audit log, and nothing else.
 *
 * There is deliberately no `POST`. Entries are written by the operations they
 * describe, inside those operations' transactions — an endpoint that let a
 * client append one would be a way to put a statement into the record with no
 * action behind it, which is the one thing a log like this must not offer.
 *
 * Admin-only. The log carries the email address of every deleted account and
 * the identity of everyone who acted, so it is strictly more sensitive than the
 * resources it describes.
 */
@ApiTags("audit")
@ApiJwtAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles("ADMIN")
@Controller("audit-log")
export class AuditLogController {
  constructor(
    @Inject(AUDIT_LOG_STORE) private readonly store: AuditLogStore,
    private readonly verifier: AuditChainVerifier,
  ) {}

  /**
   * Paging is a query parameter rather than a path segment, which also keeps
   * this controller free of any `:param` route: with a `GET :seq` declared, the
   * `verify` route below would be shadowed by whichever of the two Nest
   * registered first, and the failure would be a 400 about a malformed cursor
   * rather than anything that named the real problem.
   */
  @Get()
  @ApiOperation({
    summary: "Read the audit log (admin)",
    description:
      "Entries in chain order, oldest first. That order is not a preference: each entry's " +
      "`prevHash` names the one before it, so a page read in this direction can be verified " +
      "as it is read. Page with `afterSeq`, taking the value from the last entry's `seq`.",
  })
  @ApiOkResponse({ type: [AuditEntryResponseDto] })
  @ApiForbiddenRole()
  @ApiCommonErrors()
  async list(@Query() query: ListAuditLogQueryDto): Promise<AuditEntryResponseDto[]> {
    const entries = await this.store.read({
      limit: query.limit,
      // Validated as digits by the DTO, so `BigInt` cannot throw here. A cursor
      // past the end of the table is simply an empty page.
      ...(query.afterSeq === undefined ? {} : { afterSeq: BigInt(query.afterSeq) }),
    });
    return entries.map(AuditEntryResponseDto.from);
  }

  @Get("verify")
  @ApiOperation({
    summary: "Verify the hash chain (admin)",
    description:
      "Walks the whole chain and reports the first entry that does not add up. This is a full " +
      "scan — an operator's endpoint and a scheduled job's, not something to poll. Compare the " +
      "`headHash` it returns against a copy kept outside this service: a chain rewritten from " +
      "the genesis entry verifies perfectly, and only an external witness catches that.",
  })
  @ApiOkResponse({ type: ApiEnvelopeOf(AuditChainReportDto) })
  @ApiForbiddenRole()
  @ApiCommonErrors()
  async verify(): Promise<AuditChainReportDto> {
    return AuditChainReportDto.from(await this.verifier.verify());
  }
}
