/** Dispatched misses in a row that open the breaker. */
export const SPEECH_BREAKER_MISSES = 2;
/** Each consecutive reopening without an in-budget result waits the next window. */
export const SPEECH_BREAKER_WINDOWS_MS = [5000, 10000, 20000, 30000] as const;

/**
 * Stops feeding a detector whose inferences keep outliving their budgets, so
 * the child stops burning CPU on results that are thrown away. Only misses of
 * dispatched jobs count; a job that expired while queued says nothing about
 * the child. A tripped breaker starts its window only once the slot is free,
 * so it never closes while a timed-out inference is still running. After the
 * window one probe is admitted: in budget closes it, a miss reopens it.
 */
export function createSpeechBreaker(now: () => number) {
  let misses = 0;
  let reopenings = 0;
  let state: "closed" | "tripped" | "open" | "probing" = "closed";
  let openUntil = 0;
  const reset = (): void => {
    misses = 0;
    reopenings = 0;
    state = "closed";
  };
  return {
    /** Whether new work may enter; the first admission after a window is the probe. */
    admit(): boolean {
      if (state === "closed") return true;
      if (state !== "open" || now() < openUntil) return false;
      state = "probing";
      return true;
    },
    dispatching(): boolean {
      return state === "closed" || state === "probing";
    },
    miss(): void {
      misses++;
      if (state === "probing" || misses >= SPEECH_BREAKER_MISSES) {
        misses = 0;
        state = "tripped";
      }
    },
    success: reset,
    slotFreed(): void {
      if (state !== "tripped") return;
      const last = SPEECH_BREAKER_WINDOWS_MS.length - 1;
      openUntil = now() + SPEECH_BREAKER_WINDOWS_MS[Math.min(reopenings, last)];
      reopenings++;
      state = "open";
    },
    reset,
  };
}
