/**
 * What request scope costs, measured rather than asserted.
 *
 *     pnpm bench:scopes
 *
 * Two applications with the same five-deep dependency chain behind the same
 * handler. They differ in one word: the leaf of one chain is declared
 * `Scope.REQUEST`. Everything above it inherits that, so the second application
 * rebuilds five providers and a controller on every request while the first
 * builds them once.
 *
 * Two numbers come out, because they answer different questions:
 *
 * - **Resolution** is the container alone — how long it takes to produce the
 *   controller for one request, with no HTTP, no handler and no serialisation.
 *   It is the cost request scope adds, isolated.
 * - **End to end** is the same measurement a client would make, over a real
 *   socket. It is the number that matters for a decision, and it is much
 *   smaller in relative terms, because the DI work sits next to everything
 *   else a request does.
 *
 * Report both. A benchmark that only shows the first invites rewriting a
 * codebase over microseconds; one that only shows the second hides why the
 * regression appeared. Nothing here touches a database, a cache or a network
 * beyond loopback, so these are upper bounds on the *relative* difference: a
 * handler that awaits Postgres will show a far smaller one.
 *
 * The results in docs/di-scopes.md were produced by this file. Re-run it
 * before quoting them — an absolute number from someone else's machine is
 * worth nothing, and the ratio is what the document actually relies on.
 */
import { Controller, Get, Injectable, Module, Scope } from "@nestjs/common";
import { ContextIdFactory, NestFactory } from "@nestjs/core";
import type { INestApplication } from "@nestjs/common";
import type { ContextId } from "@nestjs/core";
import { ModuleRef } from "@nestjs/core";

const WARMUP_REQUESTS = 500;
const MEASURED_REQUESTS = 3_000;
const MEASURED_RESOLUTIONS = 20_000;
/**
 * Each phase runs this many times and the median is reported. One trial is not
 * enough: a single sequential pass over loopback swung between 1% and 37% on
 * the machine this was written on, entirely on socket scheduling, which is
 * enough noise to support whatever conclusion you went looking for.
 */
const TRIALS = 5;

/** Bumped by every constructor in either chain, so the build count is observable. */
let constructions = 0;

// ─── The static chain: one instance of each, for the life of the process ─────

@Injectable()
class StaticLeaf {
  constructor() {
    constructions += 1;
  }
}

@Injectable()
class StaticLevel3 {
  constructor(readonly next: StaticLeaf) {
    constructions += 1;
  }
}

@Injectable()
class StaticLevel2 {
  constructor(readonly next: StaticLevel3) {
    constructions += 1;
  }
}

@Injectable()
class StaticLevel1 {
  constructor(readonly next: StaticLevel2) {
    constructions += 1;
  }
}

@Controller("bench")
class StaticController {
  constructor(readonly next: StaticLevel1) {
    constructions += 1;
  }

  @Get()
  handle(): { ok: boolean } {
    return { ok: true };
  }
}

@Module({
  controllers: [StaticController],
  providers: [StaticLevel1, StaticLevel2, StaticLevel3, StaticLeaf],
})
class StaticModule {}

// ─── The scoped chain: identical, except for one word on the leaf ────────────

@Injectable({ scope: Scope.REQUEST })
class ScopedLeaf {
  constructor() {
    constructions += 1;
  }
}

@Injectable()
class ScopedLevel3 {
  constructor(readonly next: ScopedLeaf) {
    constructions += 1;
  }
}

@Injectable()
class ScopedLevel2 {
  constructor(readonly next: ScopedLevel3) {
    constructions += 1;
  }
}

@Injectable()
class ScopedLevel1 {
  constructor(readonly next: ScopedLevel2) {
    constructions += 1;
  }
}

@Controller("bench")
class ScopedController {
  constructor(readonly next: ScopedLevel1) {
    constructions += 1;
  }

  @Get()
  handle(): { ok: boolean } {
    return { ok: true };
  }
}

@Module({
  controllers: [ScopedController],
  providers: [ScopedLevel1, ScopedLevel2, ScopedLevel3, ScopedLeaf],
})
class ScopedModule {}

interface Measurement {
  readonly label: string;
  readonly constructionsPerRequest: number;
  readonly resolutionMicros: number;
  readonly endToEndMillis: number;
  readonly requestsPerSecond: number;
}

async function measure(
  label: string,
  module: typeof StaticModule | typeof ScopedModule,
  controller: typeof StaticController | typeof ScopedController,
): Promise<Measurement> {
  const app: INestApplication = await NestFactory.create(module, { logger: false });
  await app.listen(0);
  const url = (await app.getUrl()).replace("[::1]", "127.0.0.1") + "/bench";

  for (let i = 0; i < WARMUP_REQUESTS; i += 1) await fetch(url);

  const before = constructions;
  const endToEndNanos = await medianOfTrials(async () => {
    for (let i = 0; i < MEASURED_REQUESTS; i += 1) await fetch(url);
  }, MEASURED_REQUESTS);
  const constructionsPerRequest = (constructions - before) / (MEASURED_REQUESTS * TRIALS);

  // The container on its own, reached the way the router reaches it.
  const moduleRef = app.get(ModuleRef);
  const resolutionNanos = await medianOfTrials(async () => {
    for (let i = 0; i < MEASURED_RESOLUTIONS; i += 1) {
      const contextId: ContextId = ContextIdFactory.create();
      await moduleRef.resolve(controller, contextId, { strict: false });
    }
  }, MEASURED_RESOLUTIONS);

  await app.close();

  return {
    label,
    constructionsPerRequest,
    resolutionMicros: resolutionNanos / 1_000,
    endToEndMillis: endToEndNanos / 1_000_000,
    requestsPerSecond: 1_000_000_000 / endToEndNanos,
  };
}

/** Median nanoseconds per operation over {@link TRIALS} passes. */
async function medianOfTrials(pass: () => Promise<void>, operations: number): Promise<number> {
  const perOperation: number[] = [];
  for (let trial = 0; trial < TRIALS; trial += 1) {
    const startedAt = process.hrtime.bigint();
    await pass();
    perOperation.push(Number(process.hrtime.bigint() - startedAt) / operations);
  }
  perOperation.sort((a, b) => a - b);
  return perOperation[Math.floor(perOperation.length / 2)] ?? 0;
}

function report(rows: readonly Measurement[]): void {
  const [singleton, scoped] = rows;
  if (!singleton || !scoped) return;

  const table = rows.map((row) => ({
    chain: row.label,
    "constructions/req": row.constructionsPerRequest,
    "resolution (µs)": Number(row.resolutionMicros.toFixed(1)),
    "end to end (ms)": Number(row.endToEndMillis.toFixed(3)),
    "req/s": Math.round(row.requestsPerSecond),
  }));

  console.table(table);
  console.log(
    [
      `Node ${process.version} on ${process.platform}/${process.arch}`,
      `${MEASURED_REQUESTS} requests and ${MEASURED_RESOLUTIONS} resolutions per trial, ` +
        `${TRIALS} trials, median, sequential.`,
      `Resolution: ${(scoped.resolutionMicros / singleton.resolutionMicros).toFixed(1)}× slower request-scoped.`,
      `End to end: ${(scoped.endToEndMillis / singleton.endToEndMillis).toFixed(2)}× slower request-scoped ` +
        `(${((1 - scoped.requestsPerSecond / singleton.requestsPerSecond) * 100).toFixed(0)}% fewer req/s).`,
    ].join("\n"),
  );
}

async function main(): Promise<void> {
  // Sequentially, so the two applications never compete for the event loop.
  const singleton = await measure("all singletons", StaticModule, StaticController);
  const scoped = await measure("request-scoped leaf", ScopedModule, ScopedController);
  report([singleton, scoped]);
}

void main();
