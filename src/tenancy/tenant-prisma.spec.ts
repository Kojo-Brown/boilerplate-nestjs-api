import { Prisma } from "@prisma/client";
import { MissingTenantContextError, runInTenant } from "./tenant-context";
import {
  TENANT_SETTING,
  setTransactionTenant,
  tenantScopeExtension,
  tenantSetting,
} from "./tenant-prisma";
import type { TenantBatchClient } from "./tenant-prisma";

describe("tenantSetting", () => {
  it("binds the tenant as a parameter rather than interpolating it", () => {
    const statement = tenantSetting("acme");

    // `SET LOCAL` takes no parameters, which is why this is `set_config`: the
    // tenant arrives from a `Host` header, and a value that reaches SQL as text is
    // one refactor away from being the injection this feature would have caused.
    expect(statement.strings.join("?")).toContain("set_config");
    expect(statement.values).toEqual([TENANT_SETTING, "acme"]);
  });

  it("asks for a transaction-local setting", () => {
    // Session-level would outlive the request and behind a pool the next request
    // handed that connection would inherit the previous tenant — the exact leak
    // the feature exists to prevent, visible only under concurrency.
    expect(tenantSetting("acme").sql.toUpperCase()).toContain("TRUE");
  });
});

describe("setTransactionTenant", () => {
  it("issues the setting for the tenant in scope", async () => {
    const executeRaw = jest.fn().mockResolvedValue(0);

    const set = await runInTenant("acme", () => setTransactionTenant({ $executeRaw: executeRaw }));

    expect(set).toBe(true);
    expect(executeRaw).toHaveBeenCalledWith(tenantSetting("acme"));
  });

  it("issues nothing, and does not throw, with no tenant in scope", async () => {
    // The same runner opens transactions for the outbox relay and the saga poller,
    // which run under no request and write only to tables with no tenant column.
    // Refusing here would stop them dead; the policies refuse them anything else.
    const executeRaw = jest.fn().mockResolvedValue(0);

    const set = await setTransactionTenant({ $executeRaw: executeRaw });

    expect(set).toBe(false);
    expect(executeRaw).not.toHaveBeenCalled();
  });

  it("takes an explicit tenant over the one in scope, for a caller that has one in hand", async () => {
    const executeRaw = jest.fn().mockResolvedValue(0);

    await runInTenant("acme", () => setTransactionTenant({ $executeRaw: executeRaw }, "globex"));

    expect(executeRaw).toHaveBeenCalledWith(tenantSetting("globex"));
  });
});

describe("tenantScopeExtension", () => {
  /**
   * A client that records the batches it is given and answers them.
   *
   * The extension is tested against this rather than against a real client because
   * what it has to get right is the *shape* of what it sends: two statements, in
   * one `$transaction`, the setting first. Whether Postgres then honours a
   * transaction-local setting is Postgres's business and is asserted against a real
   * one in `test/tenant-isolation.db-spec.ts`.
   */
  function recordingClient(result: unknown = { id: "user-1" }) {
    const batches: Prisma.PrismaPromise<unknown>[][] = [];
    const client: TenantBatchClient = {
      $executeRaw: ((statement: Prisma.Sql) =>
        statement as unknown as Prisma.PrismaPromise<number>) as TenantBatchClient["$executeRaw"],
      $transaction: (operations) => {
        batches.push(operations);
        return Promise.resolve([0, result]);
      },
    };
    return { client, batches };
  }

  /**
   * Reaches the `$allOperations` callback inside a defined extension.
   *
   * `Prisma.defineExtension` returns the *applier* — a function that calls
   * `client.$extends(args)` — rather than the arguments, so the arguments are
   * recovered by applying it to a client whose `$extends` hands them back. The
   * alternative is a real `PrismaClient` and a database in a unit spec, to assert
   * on something that is pure argument-shaping.
   */
  function configOf(extension: ReturnType<typeof tenantScopeExtension>): {
    query: { $allModels: { $allOperations: (args: unknown) => Promise<unknown> } };
  } {
    const capture = { $extends: (args: unknown) => args };
    return (extension as unknown as (client: unknown) => unknown)(capture) as {
      query: { $allModels: { $allOperations: (args: unknown) => Promise<unknown> } };
    };
  }

  /** What Prisma hands a `$allOperations` callback, as far as this extension reads it. */
  function invoke(
    extension: ReturnType<typeof tenantScopeExtension>,
    query: jest.Mock,
  ): Promise<unknown> {
    const operations = configOf(extension).query.$allModels.$allOperations;

    return operations({
      model: "User",
      operation: "findMany",
      args: { where: { email: "person@example.test" } },
      query,
    });
  }

  it("runs the setting and the query as one two-statement transaction", async () => {
    const { client, batches } = recordingClient();
    const query = jest.fn().mockReturnValue("the query");

    await runInTenant("acme", () => invoke(tenantScopeExtension(client), query));

    expect(batches).toHaveLength(1);
    // Two statements, the setting first: a transaction-local setting applies to
    // the statements after it and to nothing before it.
    expect(batches[0]).toEqual([tenantSetting("acme"), "the query"]);
  });

  it("passes the operation's own arguments through untouched", async () => {
    const { client } = recordingClient();
    const query = jest.fn().mockReturnValue("the query");

    await runInTenant("acme", () => invoke(tenantScopeExtension(client), query));

    // The extension adds no `where` clause of its own — that is the entire point.
    // The filtering is the policy's, so there is nothing here for a caller to
    // override, forget or write a query that routes around.
    expect(query).toHaveBeenCalledWith({ where: { email: "person@example.test" } });
  });

  it("returns what the query resolved to, not the setting's row count", async () => {
    const rows = [{ id: "user-1" }];
    const { client } = recordingClient(rows);

    const result = await runInTenant("acme", () =>
      invoke(tenantScopeExtension(client), jest.fn().mockReturnValue("the query")),
    );

    expect(result).toBe(rows);
  });

  it("refuses to run at all with no tenant in scope", async () => {
    const { client, batches } = recordingClient();
    const query = jest.fn();

    await expect(invoke(tenantScopeExtension(client), query)).rejects.toThrow(
      MissingTenantContextError,
    );

    // Nothing was sent: a read with no tenant is a bug in whatever started the
    // work, and the two ways of being wrong are not symmetrical — refusing is a
    // stack trace, guessing is one customer's data in another's response.
    expect(batches).toHaveLength(0);
    expect(query).not.toHaveBeenCalled();
  });

  it("names the model and operation that was reached without a tenant", async () => {
    const { client } = recordingClient();

    await expect(invoke(tenantScopeExtension(client), jest.fn())).rejects.toThrow(/User\.findMany/);
  });

  it("reads the tenant per operation, so one client serves every request", async () => {
    const { client, batches } = recordingClient();
    const extension = tenantScopeExtension(client);
    const query = jest.fn().mockReturnValue("the query");

    await runInTenant("acme", () => invoke(extension, query));
    await runInTenant("globex", () => invoke(extension, query));

    expect(batches.map((batch) => batch[0])).toEqual([
      tenantSetting("acme"),
      tenantSetting("globex"),
    ]);
  });
});
