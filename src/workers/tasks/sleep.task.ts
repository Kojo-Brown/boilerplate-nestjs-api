/**
 * A task that resolves after `ms` milliseconds. Registered here because the
 * two useful things the pool exists to do — offloading real CPU work and
 * observing the queue behind it — need something that reliably takes time,
 * and every adapter should expose that in the same way.
 *
 * The far-side implementation ignores the caller's `AbortSignal` on purpose,
 * for the same reason `csv.encode` does: Piscina cannot cancel a running
 * task without discarding the whole thread, so making the task pretend it
 * can be cancelled would only mislead a caller. What *is* cancellable is the
 * caller's wait for it, which the pool does independently.
 */
export interface SleepInput {
  readonly ms: number;
  /**
   * Optional label echoed back in the output. Useful when several sleeps
   * share the same pool and a caller needs to tell finished ones apart in a
   * log. No effect on scheduling.
   */
  readonly label?: string;
}

export interface SleepOutput {
  readonly slept: number;
  readonly label: string | null;
}

export async function sleepTask(input: SleepInput): Promise<SleepOutput> {
  await new Promise<void>((resolve) => setTimeout(resolve, input.ms));
  return { slept: input.ms, label: input.label ?? null };
}

export interface SleepTask {
  input: SleepInput;
  output: SleepOutput;
}

declare module "../ports/worker-pool.port" {
  interface WorkerTaskMap {
    readonly "test.sleep": SleepTask;
  }
}
