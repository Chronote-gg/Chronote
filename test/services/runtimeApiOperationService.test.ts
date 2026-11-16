/** @jest-environment node */
import { runRuntimeApiOperation } from "../../src/services/runtimeApiOperationService";
import {
  hasNotionMutationTracker,
  runNotionMutation,
} from "../../src/services/notionOperationLifetime";
import { beginShutdown } from "../../src/services/shutdownSignal";

function held<T>() {
  let release!: (value: T) => void;
  const promise = new Promise<T>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

test("an operation runs with no deployment control record present", async () => {
  const handler = jest.fn(async () => "synthetic-result");
  await expect(runRuntimeApiOperation("synthetic-run", handler)).resolves.toBe(
    "synthetic-result",
  );
  expect(handler).toHaveBeenCalledTimes(1);
});

test("an operation rejects with its handler error unchanged", async () => {
  const failure = new Error("synthetic handler failure");
  await expect(
    runRuntimeApiOperation("synthetic-failure", async () => {
      throw failure;
    }),
  ).rejects.toBe(failure);
});

test("read and mutate simply run their callback", async () => {
  const result = await runRuntimeApiOperation(
    "synthetic-effects",
    async (operation) => {
      const read = await operation.read(async () => "synthetic-read");
      const mutated = await operation.mutate(async () => "synthetic-mutate");
      return [read, mutated];
    },
  );
  expect(result).toEqual(["synthetic-read", "synthetic-mutate"]);
});

test.each(["unresolved", "lost mutation response"] as const)(
  "after an unresolved outcome (%s), a later mutation in the same operation is refused",
  async (cause) => {
    const later = jest.fn(async () => "synthetic-later");
    const lost = new Error("synthetic lost response");
    const refusal = await runRuntimeApiOperation(
      "synthetic-unresolved",
      async (operation) => {
        if (cause === "unresolved") operation.unresolved();
        else
          await expect(
            operation.mutate(async () => {
              throw lost;
            }),
          ).rejects.toBe(lost);
        expect(operation.signal.aborted).toBe(true);
        return operation.mutate(later).catch((error: unknown) => error);
      },
    );
    expect(later).not.toHaveBeenCalled();
    expect(refusal).toMatchObject({ name: "AbortError" });
  },
);

test("another operation is unaffected by an unresolved outcome", async () => {
  const first = held<void>();
  const outer = runRuntimeApiOperation("synthetic-poisoned", async (op) => {
    op.unresolved();
    await first.promise;
    return op.signal.aborted;
  });
  const other = await runRuntimeApiOperation("synthetic-clean", (op) =>
    op.mutate(async () => op.signal.aborted),
  );
  first.release();
  expect(await outer).toBe(true);
  expect(other).toBe(false);
});

test("concurrent operations each receive their own signal", async () => {
  const first = held<void>();
  const signals: AbortSignal[] = [];
  const outer = runRuntimeApiOperation("synthetic-first", async (operation) => {
    signals.push(operation.signal);
    await first.promise;
  });
  await runRuntimeApiOperation("synthetic-second", async (operation) => {
    signals.push(operation.signal);
  });
  first.release();
  await outer;
  expect(signals).toHaveLength(2);
  expect(signals[0]).not.toBe(signals[1]);
});

test("a Notion mutation started inside an operation is tracked until it settles", async () => {
  const mutation = held<string>();
  let signal: AbortSignal | undefined;
  const task = runRuntimeApiOperation("synthetic-notion", async (operation) => {
    signal = operation.signal;
    return runNotionMutation(operation.signal, () => mutation.promise);
  });
  await Promise.resolve();
  expect(hasNotionMutationTracker(signal)).toBe(true);
  mutation.release("synthetic-page");
  await expect(task).resolves.toBe("synthetic-page");
  expect(hasNotionMutationTracker(signal)).toBe(false);
});

// Shutdown is process wide and irreversible, so this runs last in the file.
test("the operation signal aborts on shutdown", async () => {
  const entered = held<void>();
  const stop = held<void>();
  const task = runRuntimeApiOperation(
    "synthetic-shutdown",
    async (operation) => {
      entered.release();
      await stop.promise;
      return operation.signal;
    },
  );
  await entered.promise;
  const reason = new Error("synthetic shutdown");
  beginShutdown(reason);
  stop.release();
  const signal = await task;
  expect(signal.aborted).toBe(true);
  expect(signal.reason).toBe(reason);
});
