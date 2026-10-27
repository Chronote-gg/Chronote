import type { AdmissionContext } from "../types/deploymentControl";
import { getDeploymentControlRepository } from "../db";
import { RuntimeAdmissionUnavailable } from "./runtimeAdmissionError";
import { registerNotionMutationTracker } from "./notionOperationLifetime";
import { beginRuntimeWorkClaim } from "./runtimeWorkAdmissionService";
export type RuntimeApiOperation = {
  signal: AbortSignal;
  unresolved(): void;
  read<T>(run: () => Promise<T>): Promise<T>;
  mutate<T>(run: () => Promise<T>): Promise<T>;
};
/** A response socket is not the owner of an API handler or its issued effects. */
export async function runRuntimeApiOperation<T>(
  id: string,
  run: (operation: RuntimeApiOperation) => Promise<T>,
  admit?: (context: AdmissionContext) => Promise<boolean>,
): Promise<T> {
  const work = beginRuntimeWorkClaim("api_correction", id);
  const operation: RuntimeApiOperation = {
    signal: work.signal,
    unresolved: work.markBillingOutcomeUnknown,
    async read(effect) {
      const result = await work.trackEffect(effect);
      work.signal.throwIfAborted();
      return result;
    },
    async mutate(effect) {
      // The owner persists the acknowledged receipt before observing cancellation.
      return work.trackApiMutation(effect);
    },
  };
  const unregister = registerNotionMutationTracker(work.signal, (effect) =>
    work.trackApiMutation(effect),
  );
  return work.trackPromise(async () => {
    try {
      const authority = await work.authority();
      if (authority.kind !== "serving")
        throw new RuntimeAdmissionUnavailable(
          "API operation requires serving authority",
        );
      const admitted = admit
        ? await work.trackApiMutation(() => admit(authority.context))
        : (
            await getDeploymentControlRepository().checkAdmission(
              authority.context,
            )
          ).kind === "admitted";
      if (!admitted)
        throw new RuntimeAdmissionUnavailable("Runtime is not accepting work");
      work.claimed();
      return await run(operation);
    } finally {
      await work.settle();
      unregister();
    }
  });
}
