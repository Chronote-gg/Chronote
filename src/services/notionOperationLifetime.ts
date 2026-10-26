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
export async function runNotionMutation<T>(
  signal: AbortSignal | undefined,
  run: () => Promise<T>,
): Promise<T> {
  signal?.throwIfAborted();
  try {
    return await (signal && mutationTrackers.has(signal)
      ? mutationTrackers.get(signal)!(run)
      : run());
  } catch (error) {
    if (signal) throw new UnresolvedNotionMutation(error);
    throw error;
  }
}
export function assertNotionOutcomeKnown(
  error: unknown,
  signal?: AbortSignal,
): void {
  signal?.throwIfAborted();
  if (error instanceof UnresolvedNotionMutation) throw error;
}
