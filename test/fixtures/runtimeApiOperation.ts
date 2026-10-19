import type { RuntimeApiOperation } from "../../src/services/runtimeApiOperationService";
/** Domain fixtures explicitly supply an admitted lifetime; gate races use the real runtime. */
export function runTestApiOperation<T>(
  _id: string,
  run: (operation: RuntimeApiOperation) => Promise<T>,
): Promise<T> {
  const signal = new AbortController().signal;
  return run({
    signal,
    read: (effect) => effect(),
    mutate: (effect) => effect(),
  });
}
