import { registerNotionMutationTracker } from "../../src/services/notionOperationLifetime";
import type { RuntimeApiOperation } from "../../src/services/runtimeApiOperationService";
export async function withTestNotionOwner<T>(
  run: (signal: AbortSignal) => Promise<T>,
  signal = new AbortController().signal,
): Promise<T> {
  const unregister = registerNotionMutationTracker(signal, (effect) =>
    effect(),
  );
  try {
    return await run(signal);
  } finally {
    unregister();
  }
}
export function runTestNotionOperation<T>(
  _id: string,
  run: (operation: RuntimeApiOperation) => Promise<T>,
) {
  return withTestNotionOwner((signal) =>
    run({ signal, read: (effect) => effect(), mutate: (effect) => effect() }),
  );
}
