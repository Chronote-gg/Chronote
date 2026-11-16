/** @jest-environment node */
import { EventEmitter } from "node:events";
import {
  mockFailures,
  mockGates,
  mockRegistry,
  mockStarted,
} from "./workerMocks";
import type * as WorkerApp from "../../src/apps/worker";
import type * as WorkerShutdown from "../../src/services/workerShutdown";

type Loaded = { app: typeof WorkerApp; shutdown: typeof WorkerShutdown };
/** A fresh worker entry and shutdown, as a new process would have them. */
async function load(): Promise<Loaded> {
  let loaded: Loaded | undefined;
  await jest.isolateModulesAsync(async () => {
    // A real start-up path on ECS: the bot logs in, so its eligible work starts too.
    const isolated = (await import("../../src/services/configService")).config;
    isolated.mock.enabled = false;
    isolated.runtime.ecs = true;
    loaded = {
      app: await import("../../src/apps/worker"),
      shutdown: await import("../../src/services/workerShutdown"),
    };
  });
  if (!loaded) throw new Error("The worker entry did not load");
  return loaded;
}

/** What `bootstrap.ts` does, with the signals and the exit observable. */
function boot(loaded: Loaded, mode: WorkerApp.WorkerMode) {
  const signals = new EventEmitter();
  const exits: number[] = [];
  const exited = new Promise<number>((resolve) => {
    jest.spyOn(process, "exit").mockImplementation((code) => {
      exits.push(Number(code));
      resolve(Number(code));
      return undefined as never;
    });
  });
  const owner = loaded.shutdown.installWorkerShutdown(
    loaded.app.workerResources,
    signals,
  );
  const started = owner.runStartup(() => loaded.app.startWorker({ mode }));
  return { signals, owner, started, exited, exits };
}

beforeEach(() => {
  mockStarted.length = 0;
  mockFailures.clear();
  mockGates.webServer = undefined;
  mockRegistry.started = 0;
  mockRegistry.stopped = 0;
  mockRegistry.eligible = false;
  mockRegistry.listeners.length = 0;
  jest.spyOn(console, "log").mockImplementation(() => {});
  jest.spyOn(console, "warn").mockImplementation(() => {});
  jest.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

test.each(["login", "dependencies"])(
  "a %s failure happens before the registry starts and exits non-zero",
  async (failure) => {
    mockFailures.add(failure);
    const loaded = await load();
    const run = boot(loaded, "all");
    await expect(run.started).rejects.toThrow("synthetic");
    loaded.shutdown.failWorkerStartup(new Error("synthetic"));
    await expect(run.exited).resolves.toBe(1);
    expect(mockRegistry.started).toBe(0);
    run.owner.dispose();
  },
);

test.each([
  {
    mode: "api" as const,
    startup: ["webServer"],
    eligible: [
      "finisher",
      "meetingUpdate",
      "personalUpload",
      "processingRetry",
      "renewal",
    ],
  },
  {
    mode: "bot" as const,
    startup: ["login"],
    eligible: ["botWork", "finisher", "meetingUpdate"],
  },
])(
  "$mode mode wires the expected pieces",
  async ({ mode, startup, eligible }) => {
    const loaded = await load();
    const worker = await loaded.app.startWorker({ mode });
    expect(mockStarted).toEqual(startup);
    mockRegistry.eligible = true;
    for (const listener of mockRegistry.listeners.splice(0)) listener();
    expect(mockStarted.slice(startup.length).sort()).toEqual(eligible);
    await worker.stop();
  },
);

test("SIGTERM during start-up leaves no registry record that says ready", async () => {
  let release!: () => void;
  mockGates.webServer = new Promise<void>((resolve) => {
    release = resolve;
  });
  const loaded = await load();
  const run = boot(loaded, "all");
  while (!mockStarted.includes("webServer"))
    await new Promise((resolve) => setImmediate(resolve));
  run.signals.emit("SIGTERM");
  release();
  await expect(run.started).rejects.toThrow();
  await run.exited;
  // Start-up stopped at its next shutdown check, so the registry never wrote a record.
  expect(mockRegistry.started).toBe(0);
  expect(mockStarted).not.toContain("login");
  run.owner.dispose();
});
