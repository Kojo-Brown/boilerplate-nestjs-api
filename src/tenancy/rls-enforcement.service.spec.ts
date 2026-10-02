import { Logger } from "@nestjs/common";
import type { ConfigService } from "@nestjs/config";
import type { PrismaService } from "@/common/prisma/prisma.service";
import { RlsEnforcementService, TENANT_SCOPED_TABLES } from "./rls-enforcement.service";

interface Answers {
  role?: { role: string; bypasses: boolean };
  tables?: { table: string; enabled: boolean; forced: boolean }[];
  failWith?: Error;
}

/**
 * A client that answers the two questions the service asks, in the order it asks
 * them.
 *
 * Both are `$queryRaw` calls, so they are told apart by call order rather than by
 * matching SQL — matching the SQL would make this spec fail on a whitespace change
 * to a statement it is not about.
 */
function prismaAnswering({ role, tables = [], failWith }: Answers): PrismaService {
  let call = 0;
  return {
    $queryRaw: () => {
      if (failWith) return Promise.reject(failWith);
      call += 1;
      return Promise.resolve(call === 1 ? (role ? [role] : []) : tables);
    },
  } as unknown as PrismaService;
}

const config = (nodeEnv: string): ConfigService =>
  ({ get: () => nodeEnv }) as unknown as ConfigService;

const allProtected = TENANT_SCOPED_TABLES.map((table) => ({ table, enabled: true, forced: true }));

describe("RlsEnforcementService", () => {
  let warn: jest.SpyInstance;
  let log: jest.SpyInstance;

  beforeEach(() => {
    warn = jest.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    log = jest.spyOn(Logger.prototype, "log").mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe("inspect()", () => {
    it("reports the connected role and the tables that are unprotected", async () => {
      const service = new RlsEnforcementService(
        prismaAnswering({
          role: { role: "app_user", bypasses: false },
          tables: [
            { table: "users", enabled: true, forced: true },
            // Enabled but not forced: the policies apply to everyone except the
            // owner, which is the role that runs the migrations and very often the
            // one an operator opens psql as.
            { table: "orders", enabled: true, forced: false },
          ],
        }),
        config("development"),
      );

      await expect(service.inspect()).resolves.toEqual({
        role: "app_user",
        bypassesPolicies: false,
        unprotectedTables: ["orders", "tenants"],
      });
    });

    it("counts a table that is missing entirely as unprotected", async () => {
      // Which is what an un-migrated database looks like, and the answer must not
      // be "nothing to complain about".
      const service = new RlsEnforcementService(
        prismaAnswering({ role: { role: "app_user", bypasses: false } }),
        config("development"),
      );

      await expect(service.inspect()).resolves.toMatchObject({
        unprotectedTables: [...TENANT_SCOPED_TABLES],
      });
    });
  });

  describe("at boot", () => {
    it("says so, once, when the policies are in force", async () => {
      const service = new RlsEnforcementService(
        prismaAnswering({ role: { role: "app_user", bypasses: false }, tables: allProtected }),
        config("development"),
      );

      await service.onApplicationBootstrap();

      expect(warn).not.toHaveBeenCalled();
      expect(log).toHaveBeenCalledWith(expect.stringContaining("app_user"));
    });

    it("warns outside production when the role bypasses every policy", async () => {
      // The most likely way to deploy this application with no isolation at all is
      // to deploy it correctly and connect as `postgres`. A development machine and
      // a CI service container both do, so there it is a warning.
      const service = new RlsEnforcementService(
        prismaAnswering({ role: { role: "postgres", bypasses: true }, tables: allProtected }),
        config("development"),
      );

      await service.onApplicationBootstrap();

      expect(warn).toHaveBeenCalledWith(expect.stringContaining("BYPASSRLS"));
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("prisma/rls/app-role.sql"));
    });

    it("refuses to boot in production when the role bypasses every policy", async () => {
      const service = new RlsEnforcementService(
        prismaAnswering({ role: { role: "postgres", bypasses: true }, tables: allProtected }),
        config("production"),
      );

      await expect(service.onApplicationBootstrap()).rejects.toThrow(/BYPASSRLS/);
    });

    it("refuses to boot in production when a tenant-owned table has no enforced policy", async () => {
      const service = new RlsEnforcementService(
        prismaAnswering({
          role: { role: "app_user", bypasses: false },
          tables: [{ table: "users", enabled: false, forced: false }],
        }),
        config("production"),
      );

      await expect(service.onApplicationBootstrap()).rejects.toThrow(/users/);
    });

    it("warns rather than throwing when the check itself cannot run outside production", async () => {
      const service = new RlsEnforcementService(
        prismaAnswering({ failWith: new Error("relation pg_roles does not exist") }),
        config("development"),
      );

      await service.onApplicationBootstrap();

      expect(warn).toHaveBeenCalledWith(expect.stringContaining("relation pg_roles"));
    });

    it("refuses to boot in production when the check cannot run", async () => {
      // A connection that cannot answer this cannot answer anything, so this is a
      // failed boot either way — better the error that names what was being checked.
      const service = new RlsEnforcementService(
        prismaAnswering({ failWith: new Error("connection terminated") }),
        config("production"),
      );

      await expect(service.onApplicationBootstrap()).rejects.toThrow(/row-level security/);
    });

    it("asks nothing at all under NODE_ENV=test", async () => {
      // The e2e suite runs the whole application against an in-memory double that
      // has no `pg_roles` to ask. The real behaviour is asserted against a real
      // Postgres, and a real non-superuser role, in test/tenant-isolation.db-spec.ts.
      const queryRaw = jest.fn();
      const service = new RlsEnforcementService(
        { $queryRaw: queryRaw } as unknown as PrismaService,
        config("test"),
      );

      await service.onApplicationBootstrap();

      expect(queryRaw).not.toHaveBeenCalled();
      expect(warn).not.toHaveBeenCalled();
    });
  });
});
