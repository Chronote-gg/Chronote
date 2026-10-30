/** @jest-environment node */
jest.mock("dotenv", () => ({ config: () => ({ parsed: {} }) }));
jest.mock("../../src/meetings", () => ({
  getPendingMeetingInitializations: () => [],
  getAllMeetings: () => [],
  stopMeetingInitializations: async () => {},
}));
jest.mock("../../src/services/activeMeetingLeaseService", () => ({
  getOwnedSessionReservations: () => [],
  stopReservationRenewals: async () => {},
}));
jest.mock("../../src/services/ownedMeetingInterruption", () => ({
  interruptOwnedMeeting: jest.fn(),
  getMeetingInterruptionCheckpoints: () => [],
}));
jest.mock("../../src/services/meetingControlWorkerService", () => ({
  stopMeetingControlCommandWorker: async () => {},
}));
jest.mock("../../src/services/personalMediaUploadWorkerService", () => ({
  stopPersonalMediaUploadWorker: async () => {},
}));
jest.mock("../../src/services/analyticsService", () => ({
  shutdownAnalytics: async () => {},
}));
jest.mock("../../src/services/langfuseClient", () => ({
  shutdownLangfuseClient: async () => {},
}));
jest.mock("../../src/observability/langfuseInstrumentation", () => ({
  shutdownLangfuseTracing: async () => {},
}));
import { recoveryFixture } from "./meetingRecoveryFixtures";
import { runtime } from "../deployment/controlFixtures";
import type { RecoveryDependencies } from "../../src/services/meetingRecoveryService";
function held() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
async function readyFixture() {
  const f = await recoveryFixture();
  const row = f.histories.get("guild")![0];
  row.notesDeliveryTiming = {
    kind: "first",
    notesVersion: 1,
    path: "live",
    firstAcknowledgedAt: "2026-10-13T23:59:00Z",
  };
  const originalTiming = structuredClone(row.notesDeliveryTiming);
  row.ownerInstanceId = "old";
  row.executionVersion = 1;
  row.recovery = undefined;
  f.leases.clear();
  const originalCapture = structuredClone(row.checkpoint!.capture);
  const originalRuntime = f.records.get(JSON.stringify(["ENV", "RUNTIME#old"]));
  originalRuntime.workCounts = {
    recording: 1,
    voice_operation: 1,
    finalization: 0,
    recovery_processing: 0,
    personal_processing: 0,
    ancillary_delivery: 0,
    pending_admission: 0,
  };
  originalRuntime.readiness.expiresAt = f.now - 1;
  const voice = {
    pk: "VOICE#guild",
    sk: "STATE",
    recordType: "voice",
    protocolVersion: 1,
    guildId: "guild",
    meetingId: row.meetingId,
    ownerInstanceId: "old",
    attemptId: "old-voice",
    state: "uncertain",
    updatedAt: f.now,
  };
  f.records.set(JSON.stringify([voice.pk, voice.sk]), structuredClone(voice));
  const selected = runtime("replacement");
  const control = f.records.get(JSON.stringify(["ENV", "CONTROL"]));
  if (
    selected.identity.kind !== "ecs" ||
    originalRuntime.identity.kind !== "ecs"
  )
    throw new Error("fixture");
  selected.identity.candidateId = originalRuntime.identity.candidateId;
  control.coordinatorExpiresAt = f.now - 1;
  control.deployment = {
    runToken: "completed-rollout",
    cluster: "fixture",
    service: "fixture",
    family: "fixture",
    tablePrefix: "fixture",
    candidateId: "old",
    image: "fixture",
    runtimeMode: "all",
    phase: "complete",
    originalGeneration: 6,
    originalMembers: [runtime("previous").identity],
    outgoing: runtime("previous").identity,
    previousTaskDefinition: "fixture:1",
    taskDefinition: "fixture:2",
    candidate: originalRuntime.identity,
    updatedAt: f.now - 10,
  };
  f.records.set(JSON.stringify(["ENV", "CONTROL"]), structuredClone(control));
  f.records.set(
    JSON.stringify(["ENV", "RUNTIME#old"]),
    structuredClone(originalRuntime),
  );
  const lifecycleModule =
    await import("../../src/services/runtimeLifecycleService");
  const { createRuntimeProtectionService } =
    await import("../../src/services/runtimeProtectionService");
  const protection = createRuntimeProtectionService({
    identity: selected.identity,
    agentUri: "http://fixture.invalid",
    now: () => Math.floor(Date.now() / 1000),
    onUnsafe: () => {},
    request: async () =>
      new Response(
        JSON.stringify({
          protection: {
            TaskArn:
              selected.identity.kind === "ecs" ? selected.identity.taskArn : "",
            ProtectionEnabled: true,
            ExpirationDate: new Date((f.now + 600) * 1000).toISOString(),
          },
        }),
      ),
  });
  const lifecycle = lifecycleModule.createRuntimeLifecycle({
    identity: selected.identity,
    repository: f.repository,
    protection,
    checkpointAndFence: async () => {},
    probeReadiness: async () => ({
      gatewayReady: true,
      cacheReady: true,
      dependenciesReady: true,
    }),
  });
  lifecycleModule.installRuntimeLifecycle(lifecycle);
  await lifecycle.start();
  await lifecycle.getRuntimeAdmissionContext();
  const oldRuntime = await f.repository.getRecord("ENV", "RUNTIME#old");
  return {
    ...f,
    lifecycle,
    originalCapture,
    originalTiming,
    oldRuntime,
    voice,
  };
}
async function exerciseShutdown(mode: "terminal" | "renewal" | "stage") {
  const f = await readyFixture();
  const workers =
    await import("../../src/services/meetingRecoveryWorkerService");
  const { beginRuntimeWorkClaim, getRuntimeWorkAdmissionCheckpoints } =
    await import("../../src/services/runtimeWorkAdmissionService");
  const { recoverMeeting } =
    await import("../../src/services/meetingRecoveryService");
  const { recoverTranscript } =
    await import("../../src/services/meetingRecoveryContent");
  const entered = held(),
    tail = held(),
    renewalEntered = held(),
    renewalTail = held();
  const notes: RecoveryDependencies["notes"] = async (input) => {
    if (mode === "renewal") {
      entered.release();
      await tail.promise;
    }
    input.notesText = "Saved verified decision.";
    input.processing = { ...input.processing, notes: "generated" };
    return input.notesText;
  };
  const renew = f.repository.renewRecordingRecovery.bind(f.repository);
  const renewal = jest
    .spyOn(f.repository, "renewRecordingRecovery")
    .mockImplementation(async (...args) => {
      const result = await renew(...args);
      renewalEntered.release();
      await renewalTail.promise;
      return result;
    });
  const release = f.repository.releaseRecordingRecovery.bind(f.repository);
  const releasing = jest
    .spyOn(f.repository, "releaseRecordingRecovery")
    .mockImplementation(async (...args) => {
      const result = await release(...args);
      if (mode === "terminal") {
        entered.release();
        await tail.promise;
      }
      return result;
    });
  const update = f.repository.updateRecordingRecovery.bind(f.repository);
  const stages = jest
    .spyOn(f.repository, "updateRecordingRecovery")
    .mockImplementation(async (...args) => {
      const result = await update(...args);
      if (mode === "stage" && args[1].processing?.notes === "generated") {
        entered.release();
        await tail.promise;
        throw new Error("submitted stage response unknown");
      }
      return result;
    });
  let sent = 0;
  const send = jest.fn(async () => ({ id: `known-${++sent}` }));
  const worker = workers.createMeetingRecoveryWorker({
    repository: f.repository,
    begin: beginRuntimeWorkClaim,
    recover: recoverMeeting,
    now: () => Math.floor(Date.now() / 1000),
    content: {
      nowMs: () => f.nowMs,
      autoExport: async () => "skipped",
      reader: f.reader,
      upload: f.upload,
      transcript: recoverTranscript,
      notes,
      send,
      summaries: async (input) => {
        input.summarySentence = "Saved summary.";
        input.processing = { ...input.processing, summary: "generated" };
        return { summarySentence: input.summarySentence };
      },
    },
  });
  // Only route the singleton stop seam to this actual generated worker instance.
  jest
    .spyOn(workers, "stopMeetingRecoveryWorker")
    .mockImplementation(() => worker.stop());
  const { createRuntimeShutdown } =
    await import("../../src/services/runtimeShutdownService");
  const exit = jest
    .spyOn(process, "exit")
    .mockImplementation(() => undefined as never);
  const destroyBot = jest.fn(async () => {});
  const owner = createRuntimeShutdown({
    stopBotAdmission: jest.fn(),
    closeServer: async () => {},
    destroyBot,
  });
  const polling = worker.poll();
  try {
    await Promise.race([
      entered.promise,
      polling.then(() => {
        throw new Error(
          `Recovery finished before barrier: ${JSON.stringify(f.histories.get("guild")![0].recovery)}`,
        );
      }),
    ]);
    if (mode === "renewal") {
      await jest.advanceTimersByTimeAsync(10000);
      await renewalEntered.promise;
    }
    expect(f.lifecycle.getWorkCounts().recovery_processing).toBe(1);
    const before = {
      sent: send.mock.calls.length,
      stages: stages.mock.calls.length,
      renewals: renewal.mock.calls.length,
    };
    const stopping = owner.request("signal");
    expect(
      getRuntimeWorkAdmissionCheckpoints()
        .filter((row) => row.domain === "recovery")
        .every((row) => row.fenced),
    ).toBe(true);
    await Promise.resolve();
    expect(f.lifecycle.getWorkCounts().recovery_processing).toBe(1);
    expect(exit).not.toHaveBeenCalled();
    if (mode !== "terminal") {
      await jest.advanceTimersByTimeAsync(100001);
      expect(await stopping).toEqual({ kind: "unresolved" });
      expect(exit).toHaveBeenCalledWith(1);
      expect(owner.checkpoint().actualSettled).toBe(false);
      expect(f.lifecycle.getWorkCounts().recovery_processing).toBe(1);
      expect(destroyBot).not.toHaveBeenCalled();
    }
    tail.release();
    renewalTail.release();
    await polling;
    await owner.checkpoint().actual;
    expect(await stopping).toEqual({
      kind: mode === "terminal" ? "settled" : "unresolved",
    });
    expect(f.lifecycle.getWorkCounts().recovery_processing).toBe(
      mode === "terminal" ? 0 : 1,
    );
    expect(send).toHaveBeenCalledTimes(before.sent);
    expect(stages).toHaveBeenCalledTimes(before.stages);
    expect(renewal).toHaveBeenCalledTimes(before.renewals);
    await worker.poll();
    expect(send).toHaveBeenCalledTimes(before.sent);
    expect(f.records.get(JSON.stringify(["ENV", "RUNTIME#old"]))).toEqual(
      f.oldRuntime,
    );
    expect(f.records.get(JSON.stringify([f.voice.pk, f.voice.sk]))).toEqual(
      f.voice,
    );
    expect(f.histories.get("guild")![0].checkpoint!.capture).toEqual(
      f.originalCapture,
    );
    expect(f.histories.get("guild")![0].notesDeliveryTiming).toMatchObject({
      firstAcknowledgedAt: f.originalTiming.firstAcknowledgedAt,
      path: f.originalTiming.path,
    });
    if (mode !== "terminal")
      expect(f.histories.get("guild")![0].notesDeliveryTiming).toEqual(
        f.originalTiming,
      );
    if (mode === "terminal") {
      expect(f.histories.get("guild")![0].notesDeliveryTiming?.kind).toBe(
        "complete",
      );
      expect(releasing).toHaveBeenCalledTimes(1);
      expect(f.leases.has("guild")).toBe(false);
      expect(exit).toHaveBeenCalledWith(0);
    } else expect(f.leases.get("guild")?.sessionMode).toBe("recovery");
  } finally {
    tail.release();
    renewalTail.release();
    await worker.stop();
    await f.lifecycle.shutdown();
    owner.dispose();
  }
}
test.each(["terminal", "renewal", "stage"] as const)(
  "actual recovery %s tail remains owned through the shared shutdown budget",
  async (mode) => {
    jest.useFakeTimers({ now: Date.parse("2026-10-14T00:00:00Z") });
    try {
      await jest.isolateModulesAsync(() => exerciseShutdown(mode));
    } finally {
      jest.restoreAllMocks();
      jest.useRealTimers();
    }
  },
);
