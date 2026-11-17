/** @jest-environment node */
type ShutdownModule = typeof import("../../src/services/shutdownSignal");

function freshModule(): ShutdownModule {
  let loaded: ShutdownModule | undefined;
  jest.isolateModules(() => {
    loaded = jest.requireActual("../../src/services/shutdownSignal");
  });
  if (!loaded) throw new Error("shutdownSignal module did not load");
  return loaded;
}

test("operation signals are distinct and follow shutdown", () => {
  const shutdown = freshModule();
  const first = shutdown.operationSignal();
  const second = shutdown.operationSignal();
  const extra = new AbortController();
  const withExtra = shutdown.operationSignal(extra.signal);

  expect(first).not.toBe(second);
  expect(first).not.toBe(shutdown.getShutdownSignal());
  expect(shutdown.isShuttingDown()).toBe(false);

  extra.abort();
  expect(withExtra.aborted).toBe(true);
  expect(first.aborted).toBe(false);

  const reason = new Error("stop");
  shutdown.beginShutdown(reason);
  shutdown.beginShutdown(new Error("again"));

  expect(shutdown.isShuttingDown()).toBe(true);
  expect(shutdown.getShutdownSignal().reason).toBe(reason);
  expect(first.aborted).toBe(true);
  expect(second.aborted).toBe(true);
  expect(first.reason).toBe(reason);
  expect(shutdown.operationSignal().aborted).toBe(true);
});

test("each fresh module starts outside shutdown", () => {
  expect(freshModule().isShuttingDown()).toBe(false);
});
