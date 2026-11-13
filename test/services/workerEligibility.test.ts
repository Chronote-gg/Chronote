import type {
  RegistryView,
  WorkerRecord,
} from "../../src/repositories/workerRegistryRepository";
import { LIFECYCLE } from "../../src/services/lifecycleTiming";
import { resolveEligibility } from "../../src/services/workerEligibility";

const NOW = 1_000_000;
const SELF_RELEASE = 5;

function worker(overrides: Partial<WorkerRecord> = {}): WorkerRecord {
  const instanceId = overrides.instanceId ?? "synthetic-peer";
  return {
    pk: "WORKERS",
    sk: `WORKER#${instanceId}`,
    recordType: "worker",
    instanceId,
    release: SELF_RELEASE,
    ready: true,
    heartbeatAt: NOW,
    captures: 0,
    finishing: 0,
    expiresAt: NOW + LIFECYCLE.registryItemTtlSeconds,
    ...overrides,
  };
}

type Case = {
  name: string;
  ready?: boolean;
  shuttingDown?: boolean;
  view?: Partial<RegistryView>;
  legacyHeartbeats?: number[] | undefined;
  expected: ReturnType<typeof resolveEligibility>;
};

const freshLegacy = NOW - LIFECYCLE.legacyHeartbeatStaleSeconds + 1;
const staleLegacy = NOW - LIFECYCLE.legacyHeartbeatStaleSeconds;
const eligibleAfterCutover = {
  eligible: true,
  reason: "eligible",
  writeCutover: false,
} as const;

const cases: Case[] = [
  {
    name: "not ready",
    ready: false,
    expected: { eligible: false, reason: "not_ready", writeCutover: false },
  },
  {
    name: "shutting down",
    shuttingDown: true,
    expected: { eligible: false, reason: "shutting_down", writeCutover: false },
  },
  {
    name: "higher release fresh",
    view: {
      workers: [
        worker({
          release: SELF_RELEASE + 1,
          heartbeatAt: NOW - LIFECYCLE.registryFreshSeconds + 1,
        }),
      ],
    },
    expected: { eligible: false, reason: "newer_release", writeCutover: false },
  },
  {
    name: "higher release stale",
    view: {
      workers: [
        worker({
          release: SELF_RELEASE + 1,
          heartbeatAt: NOW - LIFECYCLE.registryFreshSeconds,
        }),
      ],
    },
    expected: eligibleAfterCutover,
  },
  {
    name: "same release",
    view: {
      workers: [worker({ instanceId: "synthetic-twin" }), worker()],
    },
    expected: eligibleAfterCutover,
  },
  {
    name: "legacy fresh gives standby",
    view: { cutover: false },
    legacyHeartbeats: [staleLegacy, freshLegacy],
    expected: {
      eligible: false,
      reason: "legacy_standby",
      writeCutover: false,
    },
  },
  {
    name: "legacy stale two minutes writes cutover",
    view: { cutover: false },
    legacyHeartbeats: [staleLegacy, staleLegacy - 1],
    expected: { eligible: true, reason: "eligible", writeCutover: true },
  },
  {
    name: "cutover ignores fresh legacy",
    view: { cutover: true },
    legacyHeartbeats: [NOW],
    expected: eligibleAfterCutover,
  },
  {
    name: "no legacy rows writes cutover",
    view: { cutover: false },
    legacyHeartbeats: [],
    expected: { eligible: true, reason: "eligible", writeCutover: true },
  },
];

test.each(cases)(
  "$name",
  ({
    ready = true,
    shuttingDown = false,
    view,
    legacyHeartbeats,
    expected,
  }) => {
    expect(
      resolveEligibility({
        self: { instanceId: "synthetic-self", release: SELF_RELEASE, ready },
        shuttingDown,
        view: { workers: [], cutover: true, ...view },
        legacyHeartbeats,
        now: NOW,
      }),
    ).toEqual(expected);
  },
);

test("a higher release that is not ready does not demote", () => {
  expect(
    resolveEligibility({
      self: {
        instanceId: "synthetic-self",
        release: SELF_RELEASE,
        ready: true,
      },
      shuttingDown: false,
      view: {
        workers: [worker({ release: SELF_RELEASE + 1, ready: false })],
        cutover: true,
      },
      legacyHeartbeats: undefined,
      now: NOW,
    }),
  ).toEqual(eligibleAfterCutover);
});

test("unknown legacy state before cutover stays in standby", () => {
  expect(
    resolveEligibility({
      self: {
        instanceId: "synthetic-self",
        release: SELF_RELEASE,
        ready: true,
      },
      shuttingDown: false,
      view: { workers: [], cutover: false },
      legacyHeartbeats: undefined,
      now: NOW,
    }),
  ).toEqual({ eligible: false, reason: "legacy_standby", writeCutover: false });
});
