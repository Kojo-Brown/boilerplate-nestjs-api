import { execFile } from "node:child_process";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { Role } from "@prisma/client";
import { createClient, truncateAll, uniqueEmail } from "../helpers/db";
import { integrationDatabaseUrl } from "./containers";
import type { PrismaService } from "@/common/prisma/prisma.service";

const run = promisify(execFile);

/**
 * What the committed migration history actually builds, asserted against a
 * database that began the run empty.
 *
 * The `*.db-spec.ts` suites assert behaviour *through* the schema and are the
 * right place for it. None of them asserts the schema itself, and the three
 * things below are exactly what a migration history gets wrong while every
 * behavioural suite stays green:
 *
 *  - a migration that was never applied, because `migrate deploy` stopped at an
 *    earlier failure and the job carried on;
 *  - a column added to `schema.prisma` and to nothing else, so the generated
 *    client types a field the database does not have — a runtime error on the
 *    first query that selects it, and invisible to `typecheck`;
 *  - a migration edited after it was applied somewhere, which `migrate deploy`
 *    will refuse on the next clean database and on nothing else.
 *
 * Only a database created from nothing can show any of it, which is what makes
 * this an integration suite rather than a unit one. The CI `test` job runs
 * `migrate deploy` against a service container and checks the exit code; it
 * never compares the result with `schema.prisma`.
 */
describe("migration history (Postgres)", () => {
  /** Rows `migrate deploy` writes for itself, one per applied migration. */
  interface AppliedMigration {
    readonly migration_name: string;
    readonly finished_at: Date | null;
    readonly rolled_back_at: Date | null;
  }

  let client: PrismaService;

  beforeAll(() => {
    client = createClient();
  });

  afterAll(async () => {
    await client.$disconnect();
  });

  it("applies every committed migration, in order, with none rolled back", async () => {
    const committed = (
      await readdir(path.join(process.cwd(), "prisma", "migrations"), { withFileTypes: true })
    )
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();

    const applied = await client.$queryRaw<AppliedMigration[]>`
      SELECT migration_name, finished_at, rolled_back_at
      FROM _prisma_migrations
      ORDER BY migration_name ASC
    `;

    // Not just a count: the names are compared, so a history with one migration
    // replaced by another of the same length is still caught.
    expect(applied.map((row) => row.migration_name)).toEqual(committed);

    // `migrate deploy` leaves `finished_at` null on a migration that failed
    // part-way, and the command's own exit code does not always carry that —
    // a partially applied step is the one state this table records and nothing
    // else does.
    expect(applied.filter((row) => row.finished_at === null)).toEqual([]);
    expect(applied.filter((row) => row.rolled_back_at !== null)).toEqual([]);
  });

  it("builds exactly the schema `prisma/schema.prisma` declares", async () => {
    // `--exit-code` turns the diff into a status: 0 empty, 2 not empty, 1 error.
    // `--from-config-datasource` is the live container, `--to-schema` the
    // checked-in datamodel, so a non-empty diff is the migration SQL somebody
    // would have had to write and did not.
    //
    // Prisma models tables, columns, indexes and constraints. The row-level
    // security policies and the `require_tenant_id()` function that
    // `20261002000000_add_multi_tenancy` installs are outside that model and so
    // are invisible here — `test/tenant-isolation.db-spec.ts` is what asserts
    // those, by making the database refuse a query.
    const diff = await run(
      "pnpm",
      [
        "exec",
        "prisma",
        "migrate",
        "diff",
        "--from-config-datasource",
        "--to-schema",
        "prisma/schema.prisma",
        "--exit-code",
      ],
      { env: { ...process.env, DATABASE_URL: integrationDatabaseUrl() }, timeout: 60_000 },
    ).catch((error: unknown) => error as { code?: number; stdout?: string; stderr?: string });

    const code = "code" in diff ? diff.code : 0;
    const summary = `${diff.stdout ?? ""}${diff.stderr ?? ""}`.trim();

    // Reported as a message rather than as `expect(code).toBe(0)`, because the
    // diff Prisma prints *is* the fix and a bare `2 !== 0` sends the reader to
    // run the command by hand to find out what drifted.
    expect(code === 0 ? "" : summary).toBe("");
  });

  it("accepts a write through the generated client", async () => {
    // The end of the chain the two assertions above are about: a schema that
    // matches and a history that applied are only worth anything if the client
    // generated from them can use the result. `users.tenantId` defaults to
    // `require_tenant_id()`, which reads the session GUC `createClient()` sets —
    // so this also proves the migrated database is usable the way the
    // application configures it, not merely present.
    await truncateAll(client);

    const email = uniqueEmail("schema-integration");
    const created = await client.user.create({ data: { email, role: Role.USER } });

    expect(created).toMatchObject({ email, role: Role.USER, tenantId: "default" });
    await expect(client.user.findUnique({ where: { email } })).resolves.toMatchObject({
      id: created.id,
    });

    await truncateAll(client);
  });
});
