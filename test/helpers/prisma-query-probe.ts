import type { PrismaClient } from "@prisma/client";
import type { CallRecorder } from "@/test-utils/n-plus-one";

/**
 * A client that records every operation issued through it.
 *
 * The other half of the N+1 detection in `src/test-utils/n-plus-one.ts`. That
 * one counts calls into a repository port, which is where the bug is written;
 * this one counts what actually reached the database, which is where it is
 * paid for. Both are worth having: a port whose `findMany` looped internally
 * would pass the first and fail this one, and only this one can say that the
 * ORM did not quietly issue a second statement of its own.
 *
 * Built on a Prisma client extension rather than on the query log, because the
 * log is an event stream with its own timing: a spec reading it has to decide
 * how long to wait for events that may still arrive, and the answer that works
 * on a laptop is not the answer that works on a loaded runner. An extension
 * runs inline, so a count read after the `await` is complete by construction.
 *
 * `$allOperations` at the top level covers raw statements as well as model
 * operations; a raw one is recorded under `$raw` since it names no model.
 */
export function probePrismaQueries(client: PrismaClient): {
  readonly client: PrismaClient;
  readonly recorder: CallRecorder;
} {
  const calls: string[] = [];

  const extended = client.$extends({
    query: {
      $allOperations({ model, operation, args, query }) {
        calls.push(`${model ?? "$raw"}.${operation}`);
        return query(args);
      },
    },
  });

  const recorder: CallRecorder = {
    get calls() {
      return calls;
    },
    count(match) {
      if (match === undefined) return calls.length;
      if (typeof match === "string") return calls.filter((call) => call === match).length;
      return calls.filter((call) => match.test(call)).length;
    },
    reset() {
      calls.length = 0;
    },
  };

  // An extended client is a structural subset of `PrismaClient` — it carries
  // every model delegate and every `$` method the adapters under test use — but
  // its type is a distinct one that `PrismaClient` is not assignable from. The
  // cast is the same one `asPrismaService` makes, for the same reason.
  return { client: extended as unknown as PrismaClient, recorder };
}
