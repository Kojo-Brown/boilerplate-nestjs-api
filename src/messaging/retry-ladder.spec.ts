import type { BackoffPolicy } from "@/common/backoff";
import { runRetryLadder } from "./retry-ladder";
import { LadderAbortedError } from "./messaging.errors";

/** Four attempts, three sleeps, and — with the jitter pinned to 0 — no waiting. */
const POLICY: BackoffPolicy = { baseMs: 250, maxMs: 5_000, maxAttempts: 4 };

/** Full jitter draws in `[0, ceiling)`; drawing 0 makes every sleep instant. */
const noWait = (): number => 0;

describe("runRetryLadder", () => {
  it("does not retry an operation that succeeds", async () => {
    let calls = 0;
    const result = await runRetryLadder(
      async () => {
        calls += 1;
      },
      { policy: POLICY, random: noWait },
    );

    expect(result).toEqual({ outcome: "succeeded", attempts: 1 });
    expect(calls).toBe(1);
  });

  it("retries until it succeeds and reports how many attempts that took", async () => {
    let calls = 0;
    const result = await runRetryLadder(
      async () => {
        calls += 1;
        if (calls < 3) throw new Error("not yet");
      },
      { policy: POLICY, random: noWait },
    );

    expect(result).toEqual({ outcome: "succeeded", attempts: 3 });
  });

  it("gives up after exactly `maxAttempts` and hands back the last error", async () => {
    let calls = 0;
    const result = await runRetryLadder(
      async () => {
        calls += 1;
        throw new Error(`failure ${calls}`);
      },
      { policy: POLICY, random: noWait },
    );

    // Four attempts, not five: `maxAttempts` counts the first one. An
    // off-by-one here is the difference between the configured budget and one
    // more retry against a dependency that is already struggling.
    expect(calls).toBe(4);
    expect(result.outcome).toBe("exhausted");
    expect(result).toMatchObject({ attempts: 4 });
    expect((result as { error: Error }).error.message).toBe("failure 4");
  });

  it("makes exactly one attempt when the policy allows one", async () => {
    let calls = 0;
    const result = await runRetryLadder(
      async () => {
        calls += 1;
        throw new Error("boom");
      },
      { policy: { ...POLICY, maxAttempts: 1 }, random: noWait },
    );

    expect(calls).toBe(1);
    expect(result.outcome).toBe("exhausted");
  });

  it("reports each retry with the delay it is about to wait", async () => {
    const retries: Array<{ attempt: number; delayMs: number }> = [];
    await runRetryLadder(
      async () => {
        throw new Error("boom");
      },
      {
        policy: POLICY,
        // The top of each rung, so the schedule is the un-jittered ladder.
        random: () => 0.999_999,
        onRetry: (attempt, delayMs) => retries.push({ attempt, delayMs }),
      },
    );

    // Three callbacks for four attempts — the last failure has no sleep after
    // it, because there is nothing after it.
    expect(retries).toEqual([
      { attempt: 1, delayMs: 249 },
      { attempt: 2, delayMs: 499 },
      { attempt: 3, delayMs: 999 },
    ]);
  });

  it("waits between attempts rather than spinning", async () => {
    const started = Date.now();
    await runRetryLadder(
      async () => {
        throw new Error("boom");
      },
      // A real, if tiny, ladder: 5 + 10 + 20 at the top of each rung.
      { policy: { baseMs: 5, maxMs: 100, maxAttempts: 4 }, random: () => 0.999_999 },
    );

    // Timers fire no earlier than their delay but can fire later, so the
    // assertion is one-sided on purpose: this pins that the sleeps happen at
    // all, which a `random` of 0 in the other cases deliberately removes.
    expect(Date.now() - started).toBeGreaterThanOrEqual(30);
  });

  it("aborts a sleep instead of waiting it out", async () => {
    const controller = new AbortController();
    let calls = 0;
    const started = Date.now();

    const ladder = runRetryLadder(
      async () => {
        calls += 1;
        throw new Error("boom");
      },
      // A minute per rung. Without the abort this test would time out rather
      // than fail — which is exactly what a shutdown during a broker-wide
      // failure would do to a pod, one partition at a time.
      {
        policy: { baseMs: 60_000, maxMs: 60_000, maxAttempts: 4 },
        random: () => 0.999_999,
        signal: controller.signal,
      },
    );

    // Let the first attempt fail and the ladder reach its sleep.
    await waitFor(() => calls === 1);
    controller.abort();

    await expect(ladder).rejects.toBeInstanceOf(LadderAbortedError);
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(calls).toBe(1);
  });

  it("does nothing at all when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    let calls = 0;

    await expect(
      runRetryLadder(
        async () => {
          calls += 1;
        },
        { policy: POLICY, random: noWait, signal: controller.signal },
      ),
    ).rejects.toBeInstanceOf(LadderAbortedError);

    // Not even one attempt: a consumer that is already shutting down must not
    // start work whose result it cannot commit.
    expect(calls).toBe(0);
  });

  it("does not spend an attempt on an operation the shutdown interrupted", async () => {
    const controller = new AbortController();
    let calls = 0;

    const ladder = runRetryLadder(
      async () => {
        calls += 1;
        throw new LadderAbortedError();
      },
      { policy: POLICY, random: noWait, signal: controller.signal },
    );

    // An abort raised by the operation propagates rather than being retried.
    // Treating it as a failure would let a rolling restart look like evidence
    // that a message is poison, and dead-letter events that were merely
    // interrupted.
    await expect(ladder).rejects.toBeInstanceOf(LadderAbortedError);
    expect(calls).toBe(1);
  });
});

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("timed out");
}
