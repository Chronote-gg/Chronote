/** Slow inferences in a row that open the breaker. */
export const SPEECH_BREAKER_MISSES = 2;
/** Each consecutive reopening without an in-budget inference waits the next window. */
export const SPEECH_BREAKER_WINDOWS_MS = [5000, 10000, 20000, 30000] as const;

/**
 * Stops feeding one phase to a detector whose inferences keep outliving that
 * phase's budget, so the child stops burning CPU on results that are thrown
 * away. A verdict is the child's own inference time, reported when it replies,
 * so a window always starts with the slot free. After the window one probe is
 * admitted: an in-budget inference closes the breaker, a slow one reopens it.
 */
export function createSpeechBreaker(now: () => number) {
  let misses = 0;
  let reopenings = 0;
  let state: "closed" | "open" | "probing" = "closed";
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
    /** Records a slow inference; true when it opened the breaker. */
    miss(): boolean {
      misses++;
      if (state !== "probing" && misses < SPEECH_BREAKER_MISSES) return false;
      const last = SPEECH_BREAKER_WINDOWS_MS.length - 1;
      openUntil = now() + SPEECH_BREAKER_WINDOWS_MS[Math.min(reopenings, last)];
      reopenings++;
      misses = 0;
      state = "open";
      return true;
    },
    success: reset,
    /** A probe ended without an inference verdict, so the next arrival probes. */
    probeLost(): void {
      if (state === "probing") state = "open";
    },
    reset,
  };
}
