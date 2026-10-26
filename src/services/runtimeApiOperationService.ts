import { registerNotionMutationTracker } from "./notionOperationLifetime";
import { beginRuntimeWorkClaim } from "./runtimeWorkAdmissionService";
export type RuntimeApiOperation = {
  signal: AbortSignal;
  read<T>(run: () => Promise<T>): Promise<T>;
  mutate<T>(run: () => Promise<T>): Promise<T>;
};
/** A response socket is not the owner of an API handler or its issued effects. */
export async function runRuntimeApiOperation<T>(
  id: string,
  run: (operation: RuntimeApiOperation) => Promise<T>,
): Promise<T> {
  const work = beginRuntimeWorkClaim("api_correction", id);
  const operation: RuntimeApiOperation = {
    signal: work.signal,
    async read(effect) {
      const result = await work.trackEffect(effect);
      work.signal.throwIfAborted();
      return result;
    },
    async mutate(effect) {
      const result = await work.trackApiMutation(effect);
      // A known SDK acknowledgment remains known if shutdown happened during the request.
      work.signal.throwIfAborted();
      return result;
    },
  };
  const unregister = registerNotionMutationTracker(work.signal, (effect) =>
    work.trackApiMutation(effect),
  );
  return work.trackPromise(async () => {
    try {
      await work.authority();
      work.claimed();
      return await run(operation);
    } finally {
      await work.settle();
      unregister();
    }
  });
}
