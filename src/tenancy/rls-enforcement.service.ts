import { Injectable, Logger } from "@nestjs/common";
import type { OnApplicationBootstrap } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PrismaService } from "@/common/prisma/prisma.service";

/**
 * The tables whose policies this service checks.
 *
 * The list is here rather than derived from the schema on purpose: a new
 * tenant-owned table is a decision somebody has to make, and the check that
 * notices it is missing should fail because a human added a line here, not pass
 * because a query found nothing to complain about. `prisma/rls/app-role.sql`
 * reports the inverse — any table with a `tenantId` column and no enforced policy
 * — so the two together catch both halves of the mistake.
 */
export const TENANT_SCOPED_TABLES = ["orders", "tenants", "users"] as const;

interface RoleRow {
  role: string;
  bypasses: boolean;
}

interface PolicyRow {
  table: string;
  enabled: boolean;
  forced: boolean;
}

/** What the boot-time check found. Returned rather than only logged, so a spec can assert on it. */
export interface RlsReport {
  readonly role: string;
  /** True when the connected role is a superuser or holds BYPASSRLS. */
  readonly bypassesPolicies: boolean;
  /** Tables that are missing `ENABLE`/`FORCE ROW LEVEL SECURITY`, or missing entirely. */
  readonly unprotectedTables: readonly string[];
}

/**
 * Checks at boot that the row-level security this schema declares actually
 * applies to this connection.
 *
 * It exists because the most likely way to deploy this application with no tenant
 * isolation at all is to deploy it correctly and connect as `postgres`. A policy
 * is not evaluated for a superuser or for a role with BYPASSRLS, and
 * `FORCE ROW LEVEL SECURITY` removes the table owner's exemption but not theirs —
 * so every policy in `20261002000000_add_multi_tenancy` can be present, correct
 * and tested, and silently not in force. Nothing about the application's behaviour
 * looks different: requests succeed, tenants see their own rows, and the isolation
 * is one SQL injection or one forgotten `where` away from being absent.
 *
 * In production that is refused: the process does not start. Everywhere else it is
 * a warning, because a development machine and the CI service container both run
 * as the superuser they were created with, and refusing there would mean every
 * contributor had to provision a role before they could run anything.
 *
 * The check is skipped under `NODE_ENV=test`, where the application runs against
 * an in-memory double that has no `pg_roles` to ask — the real behaviour is
 * asserted against a real Postgres, and against a real non-superuser role, in
 * `test/tenant-isolation.db-spec.ts`.
 */
@Injectable()
export class RlsEnforcementService implements OnApplicationBootstrap {
  private readonly logger = new Logger(RlsEnforcementService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    const nodeEnv = this.config.get<string>("NODE_ENV");
    if (nodeEnv === "test") return;

    const production = nodeEnv === "production";

    let report: RlsReport;
    try {
      report = await this.inspect();
    } catch (caught: unknown) {
      const message = caught instanceof Error ? caught.message : String(caught);
      // A connection that cannot answer this question is a connection that cannot
      // answer any question, so in production this is a failed boot either way —
      // better the error that says what was being checked.
      if (production) {
        throw new Error(
          `Could not verify that row-level security is in force: ${message}. The application ` +
            `refuses to serve traffic in production without that verification — see ` +
            `docs/multi-tenancy.md.`,
        );
      }
      this.logger.warn(`Could not verify row-level security: ${message}`);
      return;
    }

    this.report(report, production);
  }

  /** Reads the two facts that decide whether the policies are in force. */
  async inspect(): Promise<RlsReport> {
    const [role] = await this.prisma.$queryRaw<RoleRow[]>`
      SELECT current_user::text AS role,
             coalesce(
               (SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname = current_user),
               false
             ) AS bypasses
    `;
    if (role === undefined) {
      throw new Error("`SELECT current_user` returned no rows");
    }

    const policies = await this.prisma.$queryRaw<PolicyRow[]>`
      SELECT c.relname::text        AS table,
             c.relrowsecurity       AS enabled,
             c.relforcerowsecurity  AS forced
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public'
         AND c.relkind = 'r'
         AND c.relname = ANY (${[...TENANT_SCOPED_TABLES]}::text[])
    `;

    const protectedTables = new Set(
      policies.filter((row) => row.enabled && row.forced).map((row) => row.table),
    );

    return {
      role: role.role,
      bypassesPolicies: role.bypasses,
      unprotectedTables: TENANT_SCOPED_TABLES.filter((table) => !protectedTables.has(table)),
    };
  }

  private report(report: RlsReport, production: boolean): void {
    const problems: string[] = [];

    if (report.bypassesPolicies) {
      problems.push(
        `the connected role "${report.role}" is a superuser or holds BYPASSRLS, so no policy on ` +
          `any table applies to it — every request can read and write every tenant's rows. ` +
          `Provision the application's own role with prisma/rls/app-role.sql and point ` +
          `DATABASE_URL at it.`,
      );
    }

    if (report.unprotectedTables.length > 0) {
      problems.push(
        `these tenant-owned tables do not have row-level security enabled *and* forced: ` +
          `${report.unprotectedTables.join(", ")}. Either the migrations have not been applied ` +
          `or somebody has disabled a policy.`,
      );
    }

    if (problems.length === 0) {
      this.logger.log(
        `Row-level security is in force for ${TENANT_SCOPED_TABLES.join(", ")} as "${report.role}"`,
      );
      return;
    }

    const message = `Tenant isolation is not being enforced: ${problems.join(" Also, ")}`;
    if (production) throw new Error(message);
    this.logger.warn(message);
  }
}
