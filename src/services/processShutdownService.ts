import type { EventEmitter } from "node:events";
import {
  createPreservationBudget,
  type PreservationBudget,
} from "./preservationBudget";

export const PROCESS_PRESERVATION_MS = 100_000;
type ShutdownReason = "signal" | "startup_failure" | "protection_loss";
type Outcome = { kind: "settled" } | { kind: "unresolved" };
type Dependencies = {
  closeAdmission(): void;
  preserve(budget: PreservationBudget): Promise<boolean>;
  flush(): Promise<void>;
  exit(code: number): void;
};

/** Owns the actual shutdown chain separately from its bounded exit decision. */
export function createProcessShutdownOwner(dependencies: Dependencies) {
  const startup = new AbortController();
  let startupPromise: Promise<unknown> | undefined;
  let budget: PreservationBudget | undefined;
  let actual: Promise<Outcome> | undefined;
  let actualSettled = false;
  let result: Promise<Outcome> | undefined;
  let outcome: Outcome | undefined;
  let exitRequested = false;
  let failed = false;
  let exited = false;
  let signals: Pick<EventEmitter, "on" | "removeListener"> | undefined;
  const onSignal = () => {
    void request("signal");
  };
  function maybeExit() {
    if (!exitRequested || !outcome || exited) return;
    exited = true;
    dependencies.exit(failed || outcome.kind === "unresolved" ? 1 : 0);
  }
  async function finish(
    preservation: Promise<boolean>,
    allowance: PreservationBudget,
  ): Promise<Outcome> {
    const [preserved] = await Promise.allSettled([
      preservation,
      startupPromise,
    ]);
    allowance.signal.throwIfAborted();
    await dependencies.flush();
    allowance.signal.throwIfAborted();
    return preserved.status === "fulfilled" && preserved.value
      ? { kind: "settled" }
      : { kind: "unresolved" };
  }
  function request(reason: ShutdownReason): Promise<Outcome> {
    exitRequested ||= reason !== "protection_loss";
    failed ||= reason === "startup_failure";
    if (result) {
      maybeExit();
      return result;
    }
    budget = createPreservationBudget(Date.now() + PROCESS_PRESERVATION_MS);
    let resolve!: (value: Outcome) => void;
    result = new Promise<Outcome>((done) => {
      resolve = done;
    });
    // Publish the owner before synchronous abort/closure callbacks can reenter.
    startup.abort(new Error("Runtime shutdown started"));
    let preservation: Promise<boolean>;
    try {
      dependencies.closeAdmission();
      preservation = dependencies.preserve(budget);
    } catch {
      preservation = Promise.resolve(false);
    }
    actual = finish(preservation, budget).catch((): Outcome => ({
      kind: "unresolved",
    }));
    void actual.then(() => {
      actualSettled = true;
    });
    void budget.wait(actual).then((bounded) => {
      outcome =
        bounded.kind === "settled" ? bounded.value : { kind: "unresolved" };
      budget!.dispose();
      maybeExit();
      resolve(outcome);
    });
    return result;
  }
  return {
    startupSignal: startup.signal,
    runStartup<T>(run: () => Promise<T>): Promise<T> {
      startup.signal.throwIfAborted();
      if (startupPromise) throw new Error("Runtime startup is already owned");
      let resolve!: (value: T | PromiseLike<T>) => void;
      let reject!: (error: unknown) => void;
      const owned = new Promise<T>((done, failed) => {
        resolve = done;
        reject = failed;
      });
      startupPromise = owned;
      try {
        resolve(run());
      } catch (error) {
        reject(error);
      }
      return owned;
    },
    request,
    installSignalHandlers(target: Pick<EventEmitter, "on" | "removeListener">) {
      if (signals)
        throw new Error("Runtime signal handlers are already installed");
      signals = target;
      target.on("SIGTERM", onSignal);
      target.on("SIGINT", onSignal);
    },
    checkpoint: () => ({
      actual,
      actualSettled,
      deadline: budget?.deadline,
      result,
      outcome,
    }),
    dispose() {
      signals?.removeListener("SIGTERM", onSignal);
      signals?.removeListener("SIGINT", onSignal);
      budget?.dispose();
    },
  };
}
export type ProcessShutdownOwner = ReturnType<
  typeof createProcessShutdownOwner
>;
