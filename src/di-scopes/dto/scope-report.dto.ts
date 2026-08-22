import { ApiProperty } from "@nestjs/swagger";

export class ScopedInstanceDto {
  @ApiProperty({
    example: "RequestContextService#42",
    description: "Identity of the instance that served this request. Compare it across calls.",
  })
  readonly instanceId!: string;

  @ApiProperty({
    enum: ["DEFAULT", "REQUEST", "TRANSIENT"],
    example: "REQUEST",
    description: "The scope this provider ends up with, inherited or declared.",
  })
  readonly scope!: "DEFAULT" | "REQUEST" | "TRANSIENT";

  @ApiProperty({
    example: 42,
    description: "How many times the container has constructed this provider since boot.",
  })
  readonly constructions!: number;

  @ApiProperty({
    example: "Declared Scope.REQUEST: one instance per request, holding this request's data.",
  })
  readonly note!: string;
}

export class ScopeReportDto {
  @ApiProperty({
    example: "b0f7c2e4-6d1a-4a2f-9c3e-5a8d1e2f4b60",
    description: "Correlation id of this request, read by a request-scoped provider.",
  })
  readonly correlationId!: string;

  @ApiProperty({
    type: ScopedInstanceDto,
    description: "Default scope. The instance id is identical on every call.",
  })
  readonly singleton!: ScopedInstanceDto;

  @ApiProperty({
    type: ScopedInstanceDto,
    description: "Request scope. The instance id is different on every call.",
  })
  readonly requestScoped!: ScopedInstanceDto;

  @ApiProperty({
    type: ScopedInstanceDto,
    description: "Transient scope. One instance per injection site, per host instance.",
  })
  readonly transient!: ScopedInstanceDto;

  @ApiProperty({
    type: ScopedInstanceDto,
    description: "Declared with the default scope, rebuilt per request anyway. The trap.",
  })
  readonly inheritedRequestScope!: ScopedInstanceDto;

  @ApiProperty({
    example: 1,
    description:
      "Entries visible to the audit trail that inherited request scope. Always the entries of " +
      "the current request, because the buffer is discarded with it.",
  })
  readonly bubbledAuditEntries!: number;

  @ApiProperty({
    example: 137,
    description:
      "Entries visible to the audit trail that stayed a singleton: every entry since boot.",
  })
  readonly singletonAuditEntries!: number;

  @ApiProperty({
    example: ["FeatureFlagCache", "RequestContextService", "DiScopesController"],
    description: "Which class each transient logger instance was handed to, via INQUIRER.",
    type: [String],
  })
  readonly transientLoggerHosts!: string[];

  @ApiProperty({
    example: "RequestContextService#42",
    description:
      "The request-scoped instance reached from a singleton through ModuleRef and the " +
      "request's context id. Equal to requestScoped.instanceId — the same object, not a copy.",
  })
  readonly resolvedViaModuleRef!: string;
}
