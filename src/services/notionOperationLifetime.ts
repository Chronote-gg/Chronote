import type { RuntimeWorkClaim } from "./runtimeWorkAdmissionService";
import { RuntimeAdmissionUnavailable } from "./runtimeAdmissionError";
type MutationTracker = <T>(run: () => Promise<T>) => Promise<T>;
const mutationTrackers = new WeakMap<AbortSignal, MutationTracker>();
export function registerNotionMutationTracker(
  signal: AbortSignal,
  tracker: MutationTracker,
): () => void {
  if (mutationTrackers.has(signal))
    throw new Error("Notion operation already owned");
  mutationTrackers.set(signal, tracker);
  return () => {
    mutationTrackers.delete(signal);
  };
}
/** A submitted automatic mutation has no durable acknowledgment. Never turn it into a retryable failure. */
export class UnresolvedNotionMutation extends Error {
  constructor(cause: unknown) {
    super("Automatic Notion mutation outcome is unknown", { cause });
  }
}
export class NotionApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "NotionApiError";
  }
}
export function hasNotionMutationTracker(signal?: AbortSignal): boolean {
  return Boolean(signal && mutationTrackers.has(signal));
}
export async function runNotionMutation<T>(
  signal: AbortSignal | undefined,
  run: () => Promise<T>,
): Promise<T> {
  const tracker = signal && mutationTrackers.get(signal);
  if (!tracker)
    throw new RuntimeAdmissionUnavailable(
      "Notion mutation requires an admitted owner",
    );
  signal.throwIfAborted();
  let outcome:
    | { kind: "acknowledged"; value: T }
    | { kind: "rejected"; error: NotionApiError };
  try {
    outcome = await tracker(async () => {
      try {
        return { kind: "acknowledged" as const, value: await run() };
      } catch (error) {
        if (error instanceof NotionApiError && error.status < 500)
          return { kind: "rejected" as const, error };
        throw error;
      }
    });
  } catch (error) {
    throw new UnresolvedNotionMutation(error);
  }
  if (outcome.kind === "rejected") throw outcome.error;
  return outcome.value;
}
export function assertNotionOutcomeKnown(
  error: unknown,
  signal?: AbortSignal,
): void {
  signal?.throwIfAborted();
  if (
    error instanceof UnresolvedNotionMutation ||
    error instanceof RuntimeAdmissionUnavailable
  )
    throw error;
}

/** Inner provider effects classify submission uncertainty; cancellation after their ACK cannot erase a receipt. */
export async function runNotionReceiptChain<T>(
  signal: AbortSignal | undefined,
  run: () => Promise<T>,
): Promise<T> {
  const outcome = await runNotionMutation(signal, async () => {
    try {
      return { kind: "acknowledged" as const, value: await run() };
    } catch (error) {
      if (signal?.aborted && error === signal.reason)
        return { kind: "cancelled" as const, error };
      throw error;
    }
  });
  if (outcome.kind === "cancelled") throw outcome.error;
  return outcome.value;
}

export function registerRuntimeNotionOwner(
  work: Pick<RuntimeWorkClaim, "signal" | "trackEffect" | "fence">,
): () => void {
  return registerNotionMutationTracker(work.signal, (run) =>
    work.trackEffect(run).catch((error) => {
      work.fence();
      throw error;
    }),
  );
}
