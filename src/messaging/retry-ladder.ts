import { nextAttemptDelayMs, type BackoffPolicy } from "@/common/backoff";
import { LadderAbortedError } from "./messaging.errors";

/** What a completed ladder has to say for itself. */
export type LadderResult =
  | { readonly outcome: "succeeded"; readonly attempts: number }
  | { readonly outcome: "exhausted"; readonly attempts: number; readonly error: unknown };

export interface LadderOptions {
  readonly policy: BackoffPolicy;
  /** Jitter source. `Math.random` in production; pinned in tests. */
  readonly random: () => number;
  /**
   * Cuts a sleep short at shutdown.
   *
   * Without it, `RunningSubscription.stop()` — which waits for the handler in
   * flight rather than cutting it off — would wait out the rest of the ladder,
   * and a pod told to stop during a broker-wide failure would take the full
   * budget per partition to leave. Aborting throws {@link LadderAbortedError},
   * which the caller must let through: the message is then uncommitted and
   * redelivered, which is the correct outcome for work that was interrupted
   * rather than completed.
   */
  readonly signal?: AbortSignal;
  /** Called before each sleep, for the log line that makes a stalled partition visible. */
  readonly onRetry?: (attempt: number, delayMs: number, error: unknown) => void;
}

/**
 * Runs `operation` until it succeeds or its attempts are spent.
 *
 * ### Why the ladder is in this process rather than on the broker
 *
 * Kafka records carry no delivery count. A consumer that declines to commit gets
 * the message again, and again, with nothing anywhere to say how many times —
 * which is why redelivery alone cannot become "try five times, then give up".
 * The count has to be held by whoever is counting, and the only place that can
 * be is the process handling the message.
 *
 * The cost is that the count does not survive a crash. A message that has burned
 * four of five attempts when the pod dies comes back to its replacement with a
 * fresh five, so the real bound is attempts-per-delivery rather than
 * attempts-per-message. That is the same at-least-once bargain the rest of this
 * pipeline makes, and the alternative — persisting an attempt count keyed by
 * partition and offset — is a database write on the path of every failure, to
 * make a poison message reach the dead-letter topic slightly sooner after an
 * unrelated restart.
 *
 * ### Why it blocks the partition while it runs
 *
 * Retrying in place holds the partition for the length of the ladder, and the
 * usual alternative is a chain of retry topics that a failed message is
 * republished to so the main partition can move on. That is the wrong trade
 * *here*, and the reason is the decision `docs/messaging.md` records under **One
 * topic, keyed by the aggregate**: this stream is ordered per user, and a
 * `user.registered` diverted to a retry topic while the `user.deleted` behind it
 * sails through the main one arrives after the deletion it preceded. Ordering
 * within an aggregate is worth more than head-of-line latency on a partition
 * that is failing anyway, and the head-of-line cost is bounded — by
 * `worstCaseLadderMs`, after which the message goes to the dead-letter topic and
 * the partition moves on. Before this ladder existed it was not bounded at all.
 */
export async function runRetryLadder(
  operation: () => Promise<void>,
  options: LadderOptions,
): Promise<LadderResult> {
  const { policy, random, signal, onRetry } = options;
  let attempts = 0;

  for (;;) {
    throwIfAborted(signal);
    attempts += 1;
    try {
      await operation();
      return { outcome: "succeeded", attempts };
    } catch (error: unknown) {
      // An abort raised *by the operation* is not a failed attempt: the work was
      // interrupted, not rejected, and burning an attempt on it would make a
      // shutdown look like evidence that the message is poison.
      if (error instanceof LadderAbortedError) throw error;

      const delayMs = nextAttemptDelayMs(attempts, policy, random);
      if (delayMs === null) return { outcome: "exhausted", attempts, error };

      onRetry?.(attempts, delayMs, error);
      await sleep(delayMs, signal);
    }
  }
}

/** A cancellable sleep. Rejects with {@link LadderAbortedError} if `signal` fires. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  return new Promise<void>((resolve, reject) => {
    const done = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    const onAbort = (): void => {
      done();
      reject(new LadderAbortedError());
    };
    const timer = setTimeout(() => {
      done();
      resolve();
    }, ms);
    // A ladder must never be the reason a process that has finished its work
    // stays alive; the abort path is what makes shutdown prompt rather than
    // merely possible.
    timer.unref();
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted === true) throw new LadderAbortedError();
}
