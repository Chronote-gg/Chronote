/** @jest-environment node */
jest.mock("dotenv", () => ({ config: jest.fn() }));
jest.mock("../../src/audio", () => ({
  closeOutputFile: async () => {},
  waitForCaptureStreamSettlement: async () => {},
}));
jest.mock("../../src/commands/endMeeting", () => ({
  fenceMeetingFinalization: (meeting: { finalizationFenced: boolean }) => {
    meeting.finalizationFenced = true;
  },
}));
jest.mock("../../src/services/guildVoiceOperationService", () => ({
  whenOwnedVoiceSettled: jest.fn(async () => {}),
  prepareOwnedVoiceSession: jest.fn(),
  settleOwnedVoiceSession: jest.fn(async () => "settled"),
  waitOwnedVoiceEffects: async () => {},
}));
jest.mock("../../src/services/runtimeLifecycleService", () => ({
  beginRuntimeWork: jest.fn(() => ({
    settle: jest.fn(),
    transition: jest.fn(),
    beginOwnedControl: jest.fn(() => ({ settle: jest.fn() })),
  })),
  getRuntimeAdmissionContext: async () => ({
    instanceId: "old",
    now: Math.floor(Date.now() / 1000),
  }),
}));
jest.mock("../../src/db", () => ({
  getActiveMeetingLease: jest.fn(),
  renewActiveMeetingLease: async () => true,
  releaseActiveMeetingLease: jest.fn(),
  getDeploymentControlRepository: jest.fn(),
}));
let mockMeeting: MeetingData | undefined;
jest.mock("../../src/meetings", () => ({
  getMeeting: () => mockMeeting,
  deleteMeeting: () => {
    mockMeeting = undefined;
  },
  getPendingMeetingInitializations: jest.fn(() => []),
  restoreVoiceSessionNickname: async (meeting: MeetingData) => {
    meeting.botNicknameChanged = false;
    return true;
  },
}));
let mockReader: ReturnType<typeof createRecordingCheckpointService>;
jest.mock("../../src/services/recordingCheckpointService", () => ({
  createRecordingCheckpointService: (...args: unknown[]) =>
    args.length
      ? jest
          .requireActual("../../src/services/recordingCheckpointService")
          .createRecordingCheckpointService(...args)
      : mockReader,
}));
import type { MeetingData } from "../../src/types/meeting-data";
import type { RecoveryClaim } from "../../src/types/meetingRecovery";
import { failedInitializationRuntime } from "../fixtures/failedInitializationRuntime";
import {
  getMeeting,
  deleteMeeting,
  getPendingMeetingInitializations,
} from "../../src/meetings";
import {
  stopMeetingProcessing,
  areMeetingNoticesSettled,
} from "../../src/services/meetingProcessingLifetime";
import { createRecordingCheckpointService } from "../../src/services/recordingCheckpointService";
import { recoveryFixture } from "./meetingRecoveryFixtures";
import {
  getActiveMeetingLease,
  getDeploymentControlRepository,
} from "../../src/db";
import {
  interruptOwnedMeeting,
  prepareRecoveredMeeting,
  reconcileRecoveredMeeting,
  getMeetingInterruptionCheckpoints,
} from "../../src/services/ownedMeetingInterruption";
import {
  tryAcquireMeetingLease,
  attachMeetingReservation,
  getOwnedSessionReservations,
  unwindSessionInitialization,
} from "../../src/services/activeMeetingLeaseService";
import { recoverMeeting } from "../../src/services/meetingRecoveryService";
import { recoverTranscript } from "../../src/services/meetingRecoveryContent";
import {
  beginRuntimeWorkClaim,
  getRuntimeWorkAdmissionCheckpoints,
} from "../../src/services/runtimeWorkAdmissionService";

function originalMeeting(
  guildId: string,
  reservation: import("../../src/types/deploymentControl").SessionReservation,
): MeetingData {
  return {
    guildId,
    meetingId: "meeting",
    reservation,
    voiceChannel: { id: "channel" },
    captureAudio: false,
    recordBotAudio: false,
    audioData: {},
    botNicknameChanged: true,
    setFinished: jest.fn(),
    recordingCapture: {
      settled: async () => {},
      releaseSettledBuffers: jest.fn(),
    },
  } as unknown as MeetingData;
}
async function disposedOriginal(
  f: Awaited<ReturnType<typeof recoveryFixture>>,
) {
  let meeting!: MeetingData;
  let interrupted!: ReturnType<typeof interruptOwnedMeeting>;
  const runtime = failedInitializationRuntime({
    tryAcquireMeetingLease,
    unwindSessionInitialization,
    getMeeting,
    deleteMeeting,
    stopMeetingProcessing,
    areMeetingNoticesSettled,
    reservationTimingReceipt: () => undefined,
    verifyFixtureReservation: async () => {},
    closeFailedInitializationOutput: async () => true,
    saveMeetingStartToDatabase: async () => {
      throw new Error("Unexpected successful initialization");
    },
    initializeReservedMeeting: async (options: {
      reservation: import("../../src/types/deploymentControl").SessionReservation;
      initialization: { meeting?: MeetingData };
    }) => {
      meeting = originalMeeting(f.claim.history.guildId, options.reservation);
      options.initialization.meeting = meeting;
      mockMeeting = meeting;
      attachMeetingReservation(meeting, options.reservation);
      interrupted = interruptOwnedMeeting(meeting, {
        reason: "capture_failure",
        deadline: Date.now() + 10000,
      });
      throw new Error("Initialization aborted after local meeting setup");
    },
  });
  jest
    .mocked(getPendingMeetingInitializations)
    .mockImplementation(() => runtime.pending());
  await expect(
    runtime.initialize({
      guild: { id: f.claim.history.guildId },
      voiceChannel: { id: "channel" },
      textChannel: { id: "text" },
      creator: { id: "creator" },
      meetingId: "meeting",
      reservedAt: Date.parse(f.claim.history.timestamp),
      transcribeMeeting: true,
      generateNotes: true,
    } as never),
  ).rejects.toThrow("Initialization aborted after local meeting setup");
  expect(await interrupted).toEqual({ kind: "unresolved" });
  expect(meeting.finished).toBe(true);
  expect(mockMeeting).toBeUndefined();
  expect(
    getOwnedSessionReservations().some(
      (entry) =>
        entry.meeting === meeting && entry.reservation === meeting.reservation,
    ),
  ).toBe(true);
  return meeting;
}
async function startedOriginal(
  admit: (id: string) => ReturnType<typeof tryAcquireMeetingLease>,
  guildId: string,
) {
  const admitted = await admit("meeting");
  if (admitted.kind !== "admitted")
    throw new Error("original admission failed");
  const meeting = originalMeeting(guildId, admitted.reservation);
  mockMeeting = meeting;
  attachMeetingReservation(meeting, admitted.reservation);
  expect(
    await interruptOwnedMeeting(meeting, {
      reason: "capture_failure",
      deadline: Date.now() + 10,
    }),
  ).toEqual({ kind: "unresolved" });
  expect(meeting.finished).not.toBe(true);
  return meeting;
}

async function nextRecoveryClaim(
  f: Awaited<ReturnType<typeof recoveryFixture>>,
  claim: RecoveryClaim,
  clock: number,
  scenario: string,
) {
  expect(claim.history.recovery?.disposition).not.toBe("done");
  const receipt = structuredClone(claim.history.recoveryExport);
  expect(receipt?.intentExecutionVersion).toBe(2);
  if (scenario === "reused_export") expect(receipt?.state).toBe("skipped");
  expect(await f.repository.releaseRecordingRecovery(claim, clock)).toBe(true);
  clock += 61;
  jest.setSystemTime(clock * 1000);
  const next = await f.repository.claimRecordingRecovery({
    history: claim.history,
    lease: undefined,
    context: { ...f.context, now: clock },
    attemptId: "second-recovery",
  });
  if (!next) throw new Error("retry claim rejected");
  return { claim: next, clock };
}
async function corruptObjects(
  f: Awaited<ReturnType<typeof recoveryFixture>>,
  claim: RecoveryClaim,
  scenario: string,
) {
  if (scenario === "manifest_checksum")
    f.objects.set(
      claim.history.checkpoint!.manifest.key,
      Buffer.from("corrupt"),
    );
  if (scenario === "missing_artifact") {
    const manifest = await f.reader.read(claim.history.checkpoint!);
    f.objects.delete(manifest.manifest.artifacts[0].object.key);
  }
  if (scenario === "transcript_checksum")
    f.objects.set(claim.history.transcriptS3Key!, Buffer.from("corrupt"));
}
function expectedOutcome(scenario: string) {
  if (scenario === "no_speech") return "no_usable_speech";
  return ["transcription_disabled", "notes_disabled"].includes(scenario)
    ? "disabled"
    : "completed";
}

test.each([
  "complete",
  "retry",
  "reused_export",
  "manifest_checksum",
  "missing_artifact",
  "transcript_checksum",
  "no_speech",
  "transcription_disabled",
  "notes_disabled",
  "disposed_initialization",
])(
  "failure through real recovery and fresh admission: %s",
  async (scenario) => {
    jest.useFakeTimers({ now: Date.parse("2026-10-30T12:00:00Z") });
    const guildId = scenario;
    const requested =
      scenario === "transcription_disabled"
        ? { transcribeMeeting: false, generateNotes: false }
        : scenario === "notes_disabled"
          ? { transcribeMeeting: true, generateNotes: false }
          : undefined;
    const f = await recoveryFixture(scenario === "no_speech" ? "" : undefined, {
      guildId,
      requested,
      timestamp:
        scenario === "disposed_initialization"
          ? "2026-01-01T00:00:00.000Z"
          : undefined,
    });
    let claim = f.claim;
    let clock = f.now;
    mockReader = f.reader;
    const reserveSession = jest.fn(async () => ({ kind: "admitted" as const }));
    jest
      .mocked(getDeploymentControlRepository)
      .mockReturnValue({ ...f.repository, reserveSession });
    jest
      .mocked(getActiveMeetingLease)
      .mockImplementation(async (guildId) => f.leases.get(guildId));
    const admit = (meetingId: string) =>
      tryAcquireMeetingLease({
        guildId,
        meetingId,
        voiceChannelId: "channel",
        textChannelId: "text",
        isAutoRecording: false,
        sessionMode: "meeting",
        reservedAt: Date.now(),
        history: { ...claim.history, meetingId },
      });
    const oldMeeting =
      scenario === "disposed_initialization"
        ? await disposedOriginal(f)
        : await startedOriginal(admit, guildId);
    const original = oldMeeting.reservation!;
    const unrelatedId = `unrelated:${guildId}`;
    const unrelated = beginRuntimeWorkClaim("interaction", unrelatedId);
    let messages = 0;
    let exportCalls = 0;
    const recover = () =>
      recoverMeeting(claim, {
        repository: f.repository,
        reader: f.reader,
        signal: new AbortController().signal,
        now: () => clock,
        nowMs: Date.now,
        effect: (run) => run(),
        upload: f.upload,
        transcript: recoverTranscript,
        notes: async (input) => {
          input.processing = { ...input.processing, notes: "generated" };
          return "Recovered notes";
        },
        summaries: async (input) => {
          input.processing = { ...input.processing, summary: "generated" };
          input.summarySentence = "Recovered summary";
          return { summarySentence: input.summarySentence };
        },
        send: async () => ({ id: `message-${++messages}` }),
        autoExport: async () => {
          if (scenario === "retry" && ++exportCalls === 1)
            throw new Error("known export rejection");
          return "skipped";
        },
      });
    const update = f.repository.updateRecordingRecovery.bind(f.repository);
    let failTerminal = scenario === "reused_export";
    f.repository.updateRecordingRecovery = async (...args) => {
      if (failTerminal && args[1].recovery?.disposition === "done") {
        failTerminal = false;
        throw new Error("terminal acknowledgment interrupted");
      }
      return update(...args);
    };
    if (scenario === "reused_export")
      await expect(recover()).rejects.toThrow(
        "Recovery stage acknowledgment is unknown",
      );
    else await recover();
    if (["retry", "reused_export"].includes(scenario)) {
      ({ claim, clock } = await nextRecoveryClaim(f, claim, clock, scenario));
      await recover();
      expect(claim.history.executionVersion).toBe(3);
      expect(claim.history.recoveryExport?.intentExecutionVersion).toBe(2);
    }
    expect(claim.history.recovery).toMatchObject({
      disposition: "done",
      outcome: expectedOutcome(scenario),
      executionVersion: claim.history.executionVersion,
    });
    await prepareRecoveredMeeting(claim, new AbortController().signal, (run) =>
      run(),
    );
    expect(oldMeeting.botNicknameChanged).toBe(false);
    await corruptObjects(f, claim, scenario);
    expect(await f.repository.releaseRecordingRecovery(claim, clock)).toBe(
      true,
    );
    await reconcileRecoveredMeeting(claim);
    if (
      ["manifest_checksum", "missing_artifact", "transcript_checksum"].includes(
        scenario,
      )
    ) {
      expect(oldMeeting.finished).not.toBe(true);
      expect(original.workHandle.settle).not.toHaveBeenCalled();
      jest.useRealTimers();
      return;
    }
    expect(oldMeeting.finished).toBe(true);
    expect(mockMeeting).toBeUndefined();
    expect(original.workHandle.settle).toHaveBeenCalledTimes(1);
    expect(
      getRuntimeWorkAdmissionCheckpoints().find(
        (entry) => entry.id === unrelatedId,
      )?.signal,
    ).toBe(unrelated.signal);
    expect(unrelated.signal.aborted).toBe(false);
    expect(
      getMeetingInterruptionCheckpoints().some(
        (entry) => entry.meeting === oldMeeting,
      ),
    ).toBe(false);
    const next = await admit("next-meeting");
    if (next.kind !== "admitted") throw new Error("new admission failed");
    const controlId = `stop-next:${guildId}`;
    const control = beginRuntimeWorkClaim("control", controlId, { guildId });
    expect(
      getRuntimeWorkAdmissionCheckpoints().find((c) => c.id === controlId)
        ?.session,
    ).toMatchObject({
      meetingId: "next-meeting",
      voiceOperationAttemptId: next.reservation.voiceOperationAttemptId,
    });
    expect(
      getOwnedSessionReservations()
        .filter((entry) => entry.reservation.guildId === guildId)
        .map((entry) => entry.reservation),
    ).toEqual([next.reservation]);
    await control.settle();
    jest.useRealTimers();
  },
);
