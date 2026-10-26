/** One absolute grace allowance. Tightening it never creates a new signal or allowance. */
export function createPreservationBudget(initialDeadline: number) {
  const controller = new AbortController();
  let deadline = initialDeadline;
  let elapsedDeadline = performance.now() + Math.max(0, deadline - Date.now());
  let timer: ReturnType<typeof setTimeout>;
  function arm() {
    clearTimeout(timer);
    elapsedDeadline = Math.min(
      elapsedDeadline,
      performance.now() + Math.max(0, deadline - Date.now()),
    );
    const remaining = elapsedDeadline - performance.now();
    if (remaining <= 0)
      controller.abort(new Error("Preservation deadline reached"));
    else
      timer = setTimeout(
        () => controller.abort(new Error("Preservation deadline reached")),
        remaining,
      );
  }
  arm();
  return {
    signal: controller.signal,
    get deadline() {
      return deadline;
    },
    shorten(value: number) {
      if (value >= deadline) return;
      deadline = value;
      arm();
    },
    async wait<T>(
      promise: Promise<T>,
    ): Promise<{ kind: "settled"; value: T } | { kind: "unresolved" }> {
      if (controller.signal.aborted) return { kind: "unresolved" };
      let abort = () => {};
      try {
        return await Promise.race([
          promise.then(
            (value) =>
              controller.signal.aborted
                ? { kind: "unresolved" as const }
                : { kind: "settled" as const, value },
            () => ({ kind: "unresolved" as const }),
          ),
          new Promise<{ kind: "unresolved" }>((resolve) => {
            abort = () => resolve({ kind: "unresolved" });
            controller.signal.addEventListener("abort", abort, { once: true });
          }),
        ]);
      } finally {
        controller.signal.removeEventListener("abort", abort);
      }
    },
    dispose() {
      clearTimeout(timer);
    },
  };
}
export type PreservationBudget = ReturnType<typeof createPreservationBudget>;
