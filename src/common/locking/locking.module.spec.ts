import { Logger } from "@nestjs/common";
import { stubConfig } from "@/test-utils/stub-config";
import { InMemoryDistributedLock } from "./in-memory-distributed-lock";
import { createDistributedLock, parseRedlockNodes } from "./locking.module";
import { RedlockService } from "./redlock.service";

describe("parseRedlockNodes", () => {
  it("splits, trims, and drops the empties a hand-edited list collects", () => {
    expect(parseRedlockNodes(" redis://a:6379, redis://b:6379 ,,redis://c:6379,")).toEqual([
      "redis://a:6379",
      "redis://b:6379",
      "redis://c:6379",
    ]);
  });

  it("reads an unset variable as no nodes at all", () => {
    expect(parseRedlockNodes("")).toEqual([]);
  });
});

describe("createDistributedLock", () => {
  let warn: jest.SpyInstance;

  beforeEach(() => {
    warn = jest.spyOn(Logger.prototype, "warn").mockImplementation();
    jest.spyOn(Logger.prototype, "error").mockImplementation();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("builds the in-memory lock without touching Redis", async () => {
    const lock = await createDistributedLock(stubConfig({ DISTRIBUTED_LOCK: "memory" }));

    expect(lock).toBeInstanceOf(InMemoryDistributedLock);
  });

  it("votes over every node in REDLOCK_NODES", async () => {
    const lock = await createDistributedLock(
      stubConfig({
        DISTRIBUTED_LOCK: "redlock",
        REDLOCK_NODES: "redis://127.0.0.1:6379,redis://127.0.0.1:6380,redis://127.0.0.1:6381",
      }),
    );

    expect(lock).toBeInstanceOf(RedlockService);
    expect((lock as RedlockService).quorum).toBe(2);
    await (lock as RedlockService).onModuleDestroy();
  });

  it("falls back to REDIS_URL, and says that one node is not a quorum", async () => {
    const lock = await createDistributedLock(
      stubConfig({ DISTRIBUTED_LOCK: "redlock", REDIS_URL: "redis://127.0.0.1:6379" }),
    );

    // Not refused — a single node is a reasonable development setup — but the
    // claim Redlock makes is about surviving the loss of a minority, and a
    // minority of one is none.
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("configured with 1 node(s)"));
    await (lock as RedlockService).onModuleDestroy();
  });
});
