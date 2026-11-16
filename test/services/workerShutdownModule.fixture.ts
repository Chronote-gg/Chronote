import type * as WorkerShutdown from "../../src/services/workerShutdown";

/** A fresh copy of the worker shutdown module, because a module keeps its first run's promise for every later caller. */
export function loadWorkerShutdown(): typeof WorkerShutdown {
  let module!: typeof WorkerShutdown;
  jest.isolateModules(() => {
    module = jest.requireActual<typeof WorkerShutdown>(
      "../../src/services/workerShutdown",
    );
  });
  return module;
}
