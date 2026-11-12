import { registerNotionMutationTracker } from "./notionOperationLifetime";
import { operationSignal } from "./shutdownSignal";
export type RuntimeApiOperation = {
  signal: AbortSignal;
  unresolved(): void;
  read<T>(run: () => Promise<T>): Promise<T>;
  mutate<T>(run: () => Promise<T>): Promise<T>;
};
/**
 * A response socket is not the owner of an API handler or its issued effects.
 * Once one mutation's outcome is unknown, the operation stops issuing mutations
 * so a later write cannot build on a state nobody has confirmed.
 */
export async function runRuntimeApiOperation<T>(
  _id: string,
  run: (operation: RuntimeApiOperation) => Promise<T>,
): Promise<T> {
  const outcome = new AbortController();
  const signal = operationSignal(outcome.signal);
  const operation: RuntimeApiOperation = {
    signal,
    unresolved: () => outcome.abort(),
    read: (effect) => effect(),
    async mutate(effect) {
      signal.throwIfAborted();
      try {
        return await effect();
      } catch (error) {
        outcome.abort();
        throw error;
      }
    },
  };
  const unregister = registerNotionMutationTracker(signal, operation.mutate);
  try {
    return await run(operation);
  } finally {
    unregister();
  }
}
