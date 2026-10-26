/** @jest-environment node */
jest.mock("dotenv", () => ({ config: () => ({ parsed: {} }) }));
import { recoveryFixture } from "./meetingRecoveryFixtures";
import { runtime } from "../deployment/controlFixtures";
import type { RecoveryDependencies } from "../../src/services/meetingRecoveryService";
import type { NotionAutomationConfig } from "../../src/types/notionIntegration";
import type { MeetingHistory } from "../../src/types/db";

let mockConfig: NotionAutomationConfig | undefined;
let mockReserved = false;
const mockProvider = jest.fn<Promise<void>, [MeetingHistory, AbortSignal?]>(
  async () => {},
);
const mockNotionRepository = {
  getAutomationConfig: jest.fn(async () => mockConfig),
  getAutomationMeetingExport: jest.fn(async () => undefined),
  reserveAutomationMeetingExport: jest.fn(async () => {
    if (mockReserved) return false;
    mockReserved = true;
    return true;
  }),
};
jest.mock("../../src/repositories/notionIntegrationRepository", () => ({
  getNotionIntegrationRepository: () => mockNotionRepository,
}));
jest.mock("../../src/services/notionService", () => ({
  NotionApiError: class extends Error {},
  exportMeetingToNotionAutomation: async (params: {
    meeting: MeetingHistory;
    signal?: AbortSignal;
    userId: string;
    destinationPageId: string;
  }) => {
    expect(params.userId).toBe(mockConfig?.ownerUserId);
    expect(params.destinationPageId).toBe(mockConfig?.destinationPageId);
    const { runNotionMutation } = jest.requireActual<
      typeof import("../../src/services/notionOperationLifetime")
    >("../../src/services/notionOperationLifetime");
    await runNotionMutation(params.signal, () =>
      mockProvider(params.meeting, params.signal),
    );
    return { status: "exported", notionPageId: "generated-page" };
  },
}));

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
  return { ...f, lifecycle, originalCapture, oldRuntime, voice };
}
type Mode =
  | "read_failure"
  | "read_exhausted"
  | "marker_unknown"
  | "enabled"
  | "disabled"
  | "no_config"
  | "reserved"
  | "held"
  | "unknown"
  | "post_fence";
function installReadFailure(
  f: Awaited<ReturnType<typeof readyFixture>>,
  mode: Mode,
) {
  if (mode === "read_exhausted")
    f.histories.get("guild")![0].recovery = {
      attempt: 3,
      executionVersion: 1,
      stage: "verification",
      disposition: "failed",
      retry: { maxAttempts: 4, nextAttemptAt: null },
    };
  if (mode === "read_failure" || mode === "read_exhausted")
    mockNotionRepository.getAutomationConfig.mockRejectedValueOnce(
      new Error("eligibility read failed"),
    );
  if (mode === "marker_unknown") {
    const update = f.repository.updateRecordingRecovery.bind(f.repository);
    jest
      .spyOn(f.repository, "updateRecordingRecovery")
      .mockImplementation(async (...args) => {
        const result = await update(...args);
        if (args[1].recoveryExport?.state === "submitted") {
          jest
            .spyOn(f.repository, "getMeetingHistory")
            .mockRejectedValueOnce(new Error("marker readback unavailable"));
          throw new Error("marker ACK lost");
        }
        return result;
      });
  }
}
async function exerciseAutoExport(mode: Mode) {
  const f = await readyFixture();
  installReadFailure(f, mode);
  const { config } = await import("../../src/services/configService");
  jest.spyOn(config.notion, "enabled", "get").mockReturnValue(true);
  const { autoExportRecoveredMeeting } =
    await import("../../src/services/notionAutomationService");
  const { createMeetingRecoveryWorker } =
    await import("../../src/services/meetingRecoveryWorkerService");
  const { recoverMeeting } =
    await import("../../src/services/meetingRecoveryService");
  const { recoverTranscript } =
    await import("../../src/services/meetingRecoveryContent");
  const {
    beginRuntimeWorkClaim,
    getRuntimeWorkAdmissionCheckpoints,
    fenceRuntimeWorkAdmission,
    releaseAcknowledgedRuntimeWork,
  } = await import("../../src/services/runtimeWorkAdmissionService");
  const key = {
    guildId: "guild",
    channelId_timestamp: f.claim.history.channelId_timestamp,
  };
  const entered = held(),
    tail = held();
  let sequence = 0;
  const send = jest.fn(async () => ({ id: "generated-message-" + ++sequence }));
  const release = jest.spyOn(f.repository, "releaseRecordingRecovery");
  const autoExport = jest.fn<
    ReturnType<RecoveryDependencies["autoExport"]>,
    Parameters<RecoveryDependencies["autoExport"]>
  >(async (meeting, signal) => {
    expect(meeting.recovery).toMatchObject({
      stage: "export",
    });
    expect(meeting.processing).toMatchObject({
      notes: "generated",
      summary: "generated",
    });
    expect(meeting.delivery?.notes).toMatchObject({
      outcome: "complete",
      intended: 1,
      sent: 1,
      errors: [],
    });
    expect(meeting.delivery?.summary).toMatchObject({
      outcome: "complete",
      intended: 1,
      sent: 1,
      errors: [],
    });
    expect(meeting.notesMessageIds).toEqual(["generated-message-2"]);
    expect(meeting.summaryMessageId).toBe("generated-message-1");
    expect(release).toHaveBeenCalledTimes(autoExport.mock.calls.length - 1);
    expect(await f.repository.getMeetingHistory(key)).toEqual(meeting);
    return autoExportRecoveredMeeting(meeting, signal);
  });
  let generationCalls = 0;
  const worker = createMeetingRecoveryWorker({
    repository: f.repository,
    begin: beginRuntimeWorkClaim,
    recover: recoverMeeting,
    now: () => Math.floor(Date.now() / 1000),
    content: {
      nowMs: Date.now,
      reader: f.reader,
      upload: f.upload,
      transcript: recoverTranscript,
      send,
      autoExport,
      notes: async (input) => {
        generationCalls++;
        input.notesText = "Generated recovered partial notes.";
        input.processing = { ...input.processing, notes: "generated" };
        return input.notesText;
      },
      summaries: async (input) => {
        generationCalls++;
        input.summarySentence = "Generated saved summary.";
        input.processing = { ...input.processing, summary: "generated" };
        return { summarySentence: input.summarySentence };
      },
    },
  });
  const delayed = ["held", "unknown", "post_fence"].includes(mode);
  mockProvider.mockImplementationOnce(async (_meeting, signal) => {
    expect(signal).toBe(autoExport.mock.calls.at(-1)![1]);
    expect(signal?.aborted).toBe(false);
    if (!delayed) return;
    entered.release();
    await tail.promise;
    if (mode === "unknown")
      throw new Error("Generated unknown Notion acknowledgment");
  });
  const processing = worker.process(key);
  const id = "recovery:" + key.guildId + ":" + key.channelId_timestamp;
  try {
    if (delayed) {
      await Promise.race([
        entered.promise,
        processing.then(() => {
          throw new Error("Recovery finished before generated Notion mutation");
        }),
      ]);
      expect(f.lifecycle.getWorkCounts().recovery_processing).toBe(1);
      expect(f.leases.get("guild")?.sessionMode).toBe("recovery");
      expect(release).not.toHaveBeenCalled();
      expect(
        getRuntimeWorkAdmissionCheckpoints().find((row) => row.id === id)
          ?.effects.length,
      ).toBe(2);
      const stopping = worker.stop();
      let stopped = false;
      void stopping.then(() => {
        stopped = true;
      });
      await Promise.resolve();
      expect(stopped).toBe(false);
      if (mode === "post_fence") fenceRuntimeWorkAdmission(id);
      tail.release();
      await stopping;
    }
    await processing;
    expect(autoExport).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(2);
    expect(mockProvider).toHaveBeenCalledTimes(
      [
        "disabled",
        "no_config",
        "reserved",
        "read_failure",
        "read_exhausted",
        "marker_unknown",
      ].includes(mode)
        ? 0
        : 1,
    );
    const unresolved = [
      "unknown",
      "post_fence",
      "reserved",
      "marker_unknown",
    ].includes(mode);
    expect(f.lifecycle.getWorkCounts().recovery_processing).toBe(
      unresolved ? 1 : 0,
    );
    expect(release).toHaveBeenCalledTimes(unresolved ? 0 : 1);
    expect(f.leases.has("guild")).toBe(unresolved);
    expect(f.histories.get("guild")![0].recovery).toMatchObject(
      mode === "read_failure"
        ? {
            disposition: "failed",
            stage: "export",
            retry: {
              nextAttemptAt: new Date((f.now + 60) * 1000).toISOString(),
            },
          }
        : mode === "read_exhausted"
          ? { disposition: "needs_reconciliation", reason: "retry_exhausted" }
          : unresolved
            ? {
                disposition: "needs_reconciliation",
                reason: "export_uncertain",
              }
            : { disposition: "done", outcome: "completed" },
    );
    if (unresolved) {
      expect(
        getRuntimeWorkAdmissionCheckpoints().find((row) => row.id === id),
      ).toMatchObject({
        fenced: true,
        localSettled: true,
        terminalAcknowledged: undefined,
      });
      expect(releaseAcknowledgedRuntimeWork(id)).toBe(false);
    }
    if (unresolved) {
      const { isRecordingRecoveryCandidate } =
        await import("../../src/repositories/meetingRecoveryRepository");
      expect(
        isRecordingRecoveryCandidate(
          f.histories.get("guild")![0],
          f.now + 3600,
        ),
      ).toBe(false);
    }
    await worker.process(key);
    expect(autoExport).toHaveBeenCalledTimes(1);
    expect(mockProvider).toHaveBeenCalledTimes(
      [
        "disabled",
        "no_config",
        "reserved",
        "read_failure",
        "read_exhausted",
        "marker_unknown",
      ].includes(mode)
        ? 0
        : 1,
    );
    if (mode === "read_failure") {
      expect(f.histories.get("guild")![0].recoveryExport?.state).toBe(
        "pending",
      );
      expect(
        getRuntimeWorkAdmissionCheckpoints().find((entry) => entry.id === id),
      ).toBeUndefined();
      await jest.advanceTimersByTimeAsync(60000);
      await worker.process(key);
      expect(autoExport).toHaveBeenCalledTimes(2);
      expect(mockProvider).toHaveBeenCalledTimes(1);
      expect(send).toHaveBeenCalledTimes(2);
      expect(generationCalls).toBe(2);
      expect(f.histories.get("guild")![0].recovery).toMatchObject({
        disposition: "done",
        attempt: 2,
      });
      expect(f.leases.has("guild")).toBe(false);
      expect(f.lifecycle.getWorkCounts().recovery_processing).toBe(0);
    }
    expect(f.records.get(JSON.stringify(["ENV", "RUNTIME#old"]))).toEqual(
      f.oldRuntime,
    );
    expect(f.records.get(JSON.stringify([f.voice.pk, f.voice.sk]))).toEqual(
      f.voice,
    );
    expect(f.histories.get("guild")![0].checkpoint!.capture).toEqual(
      f.originalCapture,
    );
  } finally {
    tail.release();
    await worker.stop();
    await f.lifecycle.shutdown();
  }
}
test.each<Mode>([
  "read_failure",
  "read_exhausted",
  "marker_unknown",
  "enabled",
  "disabled",
  "no_config",
  "reserved",
  "held",
  "unknown",
  "post_fence",
])(
  "recovered Notion %s respects existing rules and owns its actual full worker lifetime",
  async (mode) => {
    jest.useFakeTimers({ now: Date.parse("2026-10-14T00:00:00Z") });
    jest.clearAllMocks();
    mockProvider.mockReset();
    mockReserved = mode === "reserved";
    mockConfig =
      mode === "no_config"
        ? undefined
        : {
            guildId: "guild",
            ownerUserId: "generated-owner",
            workspaceId: "generated-workspace",
            destinationType: "page",
            destinationPageId: "generated-existing-page",
            autoExportEnabled: mode !== "disabled",
            createdAt: "now",
            updatedAt: "now",
          };
    try {
      await jest.isolateModulesAsync(() => exerciseAutoExport(mode));
    } finally {
      jest.restoreAllMocks();
      jest.useRealTimers();
    }
  },
);
