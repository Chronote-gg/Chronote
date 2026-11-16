/** @jest-environment node */
import {
  createMockWorkerRegistryRepository,
  type LegacyRow,
  type RegistryItem,
  type WorkerRecord,
} from "../../src/repositories/workerRegistryRepository";
import { LIFECYCLE } from "../../src/services/lifecycleTiming";
import {
  LEGACY_STANDBY_UNREADABLE_LOG,
  WORKER_ELIGIBLE_LOG,
} from "../../src/metrics";
import { createWorkerRegistry } from "../../src/services/workerRegistry";

const MS_PER_SECOND = 1000;
const START_SECONDS = 1_000_000;
const SELF = "synthetic-self";
const RELEASE = 3;

function setup(options: { cutover?: boolean } = {}) {
  const items = new Map<string, RegistryItem>();
  const legacy = new Map<string, LegacyRow>();
  const repository = createMockWorkerRegistryRepository(items, legacy);
  if (options.cutover ?? true)
    items.set("CUTOVER", {
      pk: "WORKERS",
      sk: "CUTOVER",
      recordType: "cutover",
      cutoverAt: START_SECONDS,
      instanceId: "synthetic-first",
    });
  let nowMs = START_SECONDS * MS_PER_SECOND;
  let pending: (() => Promise<void>) | undefined;
  const probes = { gateway: true, server: true, shuttingDown: false };
  const registry = createWorkerRegistry({
    repository,
    resolveIdentity: async () => ({ instanceId: SELF, release: RELEASE }),
    nowMs: () => nowMs,
    schedule(run) {
      pending = run;
      return () => {
        pending = undefined;
      };
    },
    isShuttingDown: () => probes.shuttingDown,
  });
  const load = {
    captures: 1,
    finishing: 2,
    protectedUntil: START_SECONDS + 600,
  };
  const start = (mode: "all" | "bot" | "api" = "all") =>
    registry.start({
      mode,
      isGatewayReady: () => probes.gateway,
      isServerListening: () => probes.server,
      load: () => load,
    });
  async function heartbeat(advanceMs = LIFECYCLE.registryHeartbeatMs) {
    nowMs += advanceMs;
    const run = pending;
    if (!run) throw new Error("No heartbeat is scheduled");
    pending = undefined;
    await run();
  }
  const own = () => items.get(`WORKER#${SELF}`);
  const peer = (overrides: Partial<WorkerRecord>) => {
    const record: WorkerRecord = {
      pk: "WORKERS",
      sk: "WORKER#synthetic-peer",
      recordType: "worker",
      instanceId: "synthetic-peer",
      release: RELEASE + 1,
      ready: true,
      heartbeatAt: Math.floor(nowMs / MS_PER_SECOND),
      captures: 0,
      finishing: 0,
      expiresAt: START_SECONDS + LIFECYCLE.registryItemTtlSeconds,
      ...overrides,
    };
    items.set(record.sk, record);
  };
  const seconds = () => Math.floor(nowMs / MS_PER_SECOND);
  return {
    registry,
    repository,
    items,
    legacy,
    probes,
    start,
    heartbeat,
    own,
    peer,
    seconds,
    hasPending: () => pending !== undefined,
  };
}

let log: jest.SpyInstance;
let warn: jest.SpyInstance;
beforeEach(() => {
  log = jest.spyOn(console, "log").mockImplementation(() => undefined);
  warn = jest.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

test("start writes a ready record with the current load", async () => {
  const s = setup();
  await s.start();
  expect(s.own()).toEqual({
    pk: "WORKERS",
    sk: `WORKER#${SELF}`,
    recordType: "worker",
    instanceId: SELF,
    release: RELEASE,
    ready: true,
    heartbeatAt: START_SECONDS,
    captures: 1,
    finishing: 2,
    protectedUntil: START_SECONDS + 600,
    expiresAt: START_SECONDS + LIFECYCLE.registryItemTtlSeconds,
  });
  expect(s.registry.isEligible()).toBe(true);
  expect(s.registry.hasBeenReady()).toBe(true);
  expect(s.registry.getWorkerRelease()).toBe(RELEASE);
});

test("failed read keeps last view", async () => {
  const s = setup();
  s.peer({});
  await s.start();
  expect(s.registry.isEligible()).toBe(false);
  s.items.delete("WORKER#synthetic-peer");
  jest
    .spyOn(s.repository, "read")
    .mockRejectedValueOnce(new Error("synthetic outage"));
  await s.heartbeat();
  expect(s.registry.isEligible()).toBe(false);
  expect(warn).toHaveBeenCalled();
  await s.heartbeat();
  expect(s.registry.isEligible()).toBe(true);
});

test("health latch survives ready false", async () => {
  const s = setup();
  await s.start();
  expect(s.registry.hasBeenReady()).toBe(true);
  s.probes.gateway = false;
  await s.heartbeat();
  expect(s.own()?.ready).toBe(false);
  expect(s.registry.isEligible()).toBe(false);
  expect(s.registry.hasBeenReady()).toBe(true);
});

test("a worker that has never read the registry is not ready", async () => {
  const s = setup();
  jest
    .spyOn(s.repository, "read")
    .mockRejectedValueOnce(new Error("synthetic outage"));
  await s.start();
  expect(s.own()?.ready).toBe(false);
  expect(s.registry.hasBeenReady()).toBe(false);
  await s.heartbeat();
  expect(s.registry.hasBeenReady()).toBe(true);
});

test("a failed ready write does not latch health", async () => {
  const s = setup();
  jest
    .spyOn(s.repository, "put")
    .mockRejectedValueOnce(new Error("synthetic outage"));
  await s.start();
  expect(s.registry.hasBeenReady()).toBe(false);
  await s.heartbeat();
  expect(s.registry.hasBeenReady()).toBe(true);
});

test.each([
  { mode: "api" as const, gateway: false, server: true },
  { mode: "bot" as const, gateway: true, server: false },
])("$mode mode ignores the other probe", async ({ mode, gateway, server }) => {
  const s = setup();
  s.probes.gateway = gateway;
  s.probes.server = server;
  await s.start(mode);
  expect(s.registry.isEligible()).toBe(true);
});

test("shutting down is never eligible", async () => {
  const s = setup();
  await s.start();
  s.probes.shuttingDown = true;
  await s.heartbeat();
  expect(s.registry.isEligible()).toBe(false);
});

test("shutting down writes ready false and keeps reporting load", async () => {
  const s = setup();
  await s.start();
  s.probes.shuttingDown = true;
  await s.heartbeat();
  expect(s.own()).toMatchObject({
    ready: false,
    heartbeatAt: s.seconds(),
    captures: 1,
    finishing: 2,
    protectedUntil: START_SECONDS + 600,
  });
  expect(s.registry.hasBeenReady()).toBe(true);
});

test("eligibility is logged once a minute and first eligible fires once", async () => {
  const s = setup();
  const early = jest.fn();
  s.registry.onFirstEligible(early);
  await s.start();
  const late = jest.fn();
  s.registry.onFirstEligible(late);
  const heartbeatsPerLog =
    LIFECYCLE.registryEligibleLogMs / LIFECYCLE.registryHeartbeatMs;
  for (let beat = 0; beat < heartbeatsPerLog; beat += 1) await s.heartbeat();
  const eligibleLogs = log.mock.calls.filter(
    ([message]) => message === WORKER_ELIGIBLE_LOG,
  );
  expect(eligibleLogs).toHaveLength(2);
  expect(early).toHaveBeenCalledTimes(1);
  expect(late).toHaveBeenCalledTimes(1);
});

test("standby ends with a permanent cutover", async () => {
  const s = setup({ cutover: false });
  const legacyRow = (heartbeatAt: number): LegacyRow => ({
    pk: "ENV",
    sk: "RUNTIME#synthetic-old",
    heartbeatAt,
  });
  s.legacy.set("old", legacyRow(s.seconds()));
  await s.start();
  expect(s.registry.isEligible()).toBe(false);
  expect(s.own()?.ready).toBe(true);
  await s.heartbeat(LIFECYCLE.legacyHeartbeatStaleSeconds * MS_PER_SECOND - 1);
  expect(s.registry.isEligible()).toBe(false);
  await s.heartbeat(1);
  expect(s.registry.isEligible()).toBe(true);
  await expect(s.repository.read()).resolves.toMatchObject({ cutover: true });
  s.legacy.set("old", legacyRow(s.seconds()));
  await s.heartbeat();
  expect(s.registry.isEligible()).toBe(true);
});

test("stop writes ready false and ends the loop", async () => {
  const s = setup();
  await s.start();
  await s.registry.stop();
  expect(s.own()?.ready).toBe(false);
  expect(s.registry.isEligible()).toBe(false);
  expect(s.hasPending()).toBe(false);
  expect(s.registry.hasBeenReady()).toBe(true);
});

test("a stop before start resolves its identity leaves no record", async () => {
  const s = setup();
  await s.registry.stop();
  await s.start();
  expect(s.own()).toBeUndefined();
  expect(s.hasPending()).toBe(false);
  expect(s.registry.isEligible()).toBe(false);
});

test("standby held by an unreadable legacy heartbeat is logged once a minute", async () => {
  const s = setup({ cutover: false });
  const legacyRead = jest
    .spyOn(s.repository, "legacyHeartbeats")
    .mockRejectedValue(new Error("synthetic outage"));
  const error = jest.spyOn(console, "error").mockImplementation(() => {});
  const unreadable = () =>
    error.mock.calls.filter(
      ([message]) => message === LEGACY_STANDBY_UNREADABLE_LOG,
    ).length;
  await s.start();
  expect(s.registry.isEligible()).toBe(false);
  expect(unreadable()).toBe(1);
  const heartbeatsPerLog =
    LIFECYCLE.registryEligibleLogMs / LIFECYCLE.registryHeartbeatMs;
  for (let beat = 1; beat < heartbeatsPerLog; beat += 1) await s.heartbeat();
  expect(unreadable()).toBe(1);
  await s.heartbeat();
  expect(unreadable()).toBe(2);
  legacyRead.mockResolvedValue([s.seconds()]);
  await s.heartbeat(LIFECYCLE.registryEligibleLogMs);
  expect(unreadable()).toBe(2);
});

test("stop makes the worker ineligible at once, even while a heartbeat write hangs", async () => {
  const s = setup();
  await s.start();
  expect(s.registry.isEligible()).toBe(true);
  let release!: () => void;
  jest.spyOn(s.repository, "put").mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  const beat = s.heartbeat();
  await new Promise((resolve) => setImmediate(resolve));
  const stopping = s.registry.stop();
  expect(s.registry.isEligible()).toBe(false);
  release();
  await Promise.all([beat, stopping]);
  expect(s.own()?.ready).toBe(false);
});

test("the final ready false write is retried once", async () => {
  const s = setup();
  await s.start();
  const put = jest.spyOn(s.repository, "put");
  put.mockRejectedValueOnce(new Error("synthetic outage"));
  await s.registry.stop();
  expect(put).toHaveBeenCalledTimes(2);
  expect(s.own()?.ready).toBe(false);
});

test("release is unknown before start", () => {
  expect(() => setup().registry.getWorkerRelease()).toThrow();
});
