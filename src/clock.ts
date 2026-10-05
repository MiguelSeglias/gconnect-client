/** Time source and sleeper. Injectable so tests can run without real delays. */
export interface Clock {
  /** Current time in epoch milliseconds. */
  now(): number;
  /** Resolve after `ms` milliseconds. */
  sleep(ms: number): Promise<void>;
}

/** Real clock backed by `Date.now()` and `setTimeout`. */
export const systemClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) =>
    new Promise((resolve) => {
      setTimeout(resolve, ms);
    }),
};
