/** @jest-environment node */
jest.mock("dotenv", () => ({ config: jest.fn() }));
jest.mock("../../src/audio", () => ({
  closeOutputFile: async () => {},
  waitForCaptureStreamSettlement: async () => {},
}));
jest.mock("../../src/commands/endMeeting", () => ({
  fenceMeetingFinalization: jest.fn(),
}));
jest.mock("../../src/services/runtimeWorkAdmissionService", () => ({
  fenceAndSettleSessionWork: jest.fn(async () => true),
}));
jest.mock("../../src/services/meetingProcessingLifetime", () => ({
  stopMeetingProcessing: async () => {},
  areMeetingNoticesSettled: jest.fn(() => true),
}));
jest.mock("../../src/services/guildVoiceOperationService", () => ({
  settleOwnedVoiceSession: jest.fn(async () => "settled"),
  waitOwnedVoiceEffects: async () => {},
  whenOwnedVoiceSettled: jest.fn(async () => {}),
}));
jest.mock("../../src/services/activeMeetingLeaseService", () => ({
  getOwnedSessionReservations: jest.fn(() => []),
  reconcilePreservedRecordingReservation: async () => false,
  reconcileRecoveredRecordingReservation: jest.fn(async () => true),
}));
jest.mock("../../src/services/recordingCheckpointService", () => ({
  createRecordingCheckpointService: () => ({
    read: jest.fn(async () => ({ missing: [] })),
    readVerifiedObject: async () => Buffer.from("saved"),
  }),
}));
jest.mock("../../src/services/recoveredRecordingProof", () => ({
  matchesRecoveredRecording: jest.fn(() => true),
}));
jest.mock("../../src/db", () => ({
  getDeploymentControlRepository: jest.fn(),
}));
jest.mock("../../src/meetings", () => ({
  getPendingMeetingInitializations: jest.fn(() => []),
  getMeeting: jest.fn(),
  deleteMeeting: jest.fn(),
  restoreVoiceSessionNickname: jest.fn(async (meeting) => {
    meeting.botNicknameChanged = false;
    return true;
  }),
}));
import {
  interruptOwnedMeeting,
  prepareRecoveredMeeting,
  reconcileRecoveredMeeting,
  getMeetingInterruptionCheckpoints,
} from "../../src/services/ownedMeetingInterruption";
import { getDeploymentControlRepository } from "../../src/db";
import {
  getMeeting,
  deleteMeeting,
  restoreVoiceSessionNickname,
  getPendingMeetingInitializations,
} from "../../src/meetings";
import { fenceAndSettleSessionWork } from "../../src/services/runtimeWorkAdmissionService";
import {
  settleOwnedVoiceSession,
  whenOwnedVoiceSettled,
} from "../../src/services/guildVoiceOperationService";
import { areMeetingNoticesSettled } from "../../src/services/meetingProcessingLifetime";
import {
  reconcileRecoveredRecordingReservation,
  getOwnedSessionReservations,
} from "../../src/services/activeMeetingLeaseService";
import type { MeetingData } from "../../src/types/meeting-data";
import type { RecoveryClaim } from "../../src/types/meetingRecovery";
import { failedInitializationRuntime } from "../fixtures/failedInitializationRuntime";
function held() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function expireOriginalFailure(meeting: MeetingData) {
  const original = interruptOwnedMeeting(meeting, {
    reason: "capture_failure",
    deadline: 1010,
  });
  await jest.advanceTimersByTimeAsync(10);
  return { original };
}
beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(settleOwnedVoiceSession).mockResolvedValue("settled");
  jest.mocked(whenOwnedVoiceSettled).mockImplementation(async () => {});
  jest.useFakeTimers();
  jest.setSystemTime(1000);
});
afterEach(() => jest.useRealTimers());
function fixture() {
  const local = held();
  const reservation = {
    guildId: "guild",
    meetingId: "meeting",
    ownerInstanceId: "worker",
    executionVersion: 1,
    voiceOperationAttemptId: "voice",
    sessionMode: "meeting",
    historyKey: { guildId: "guild", channelId_timestamp: "key" },
  };
  const meeting = {
    ...reservation,
    reservation,
    recordingContentTask: local.promise,
    audioData: {},
    botNicknameChanged: true,
    setFinished: jest.fn(),
    recordingCapture: {
      settled: async () => {},
      releaseSettledBuffers: jest.fn(),
    },
  } as unknown as MeetingData;
  const claim = {
    history: {
      guildId: "guild",
      channelId_timestamp: "key",
      meetingId: "meeting",
      ownerInstanceId: "worker",
      executionVersion: 2,
      checkpoint: { revision: 1 },
      recoveryTranscript: { object: {} },
    },
    lease: {
      sessionMode: "recovery",
      guildId: "guild",
      meetingId: "meeting",
      ownerInstanceId: "worker",
      executionVersion: 2,
      recoveryAttemptId: "recovery",
      leaseExpiresAt: 100,
    },
  } as RecoveryClaim;
  jest.mocked(getMeeting).mockReturnValue(meeting);
  jest
    .mocked(getOwnedSessionReservations)
    .mockReturnValue([{ meeting, reservation: meeting.reservation! }]);
  jest.mocked(getDeploymentControlRepository).mockReturnValue({
    getMeetingHistory: async () => claim.history,
    getRecoveryLease: async () => claim.lease,
  } as never);
  return { local, meeting, claim };
}
test.each([true, false])(
  "terminal recovery and original lifetime reconcile in either order: %s",
  async (settleFirst) => {
    const { local, meeting, claim } = fixture();
    const { original } = await expireOriginalFailure(meeting);
    expect(await original).toEqual({ kind: "unresolved" });
    if (settleFirst) {
      local.resolve();
      await jest.advanceTimersByTimeAsync(0);
    }
    const effect = jest.fn(async (run: () => Promise<unknown>) => run());
    const preparation = prepareRecoveredMeeting(
      claim,
      new AbortController().signal,
      effect,
    );
    if (!settleFirst) {
      expect(restoreVoiceSessionNickname).not.toHaveBeenCalled();
      local.resolve();
    }
    await preparation;
    expect(effect).toHaveBeenCalledTimes(1);
    expect(meeting.botNicknameChanged).toBe(false);
    await reconcileRecoveredMeeting(claim);
    expect(meeting.finished).toBe(true);
    expect(deleteMeeting).toHaveBeenCalledWith("guild");
    expect(reconcileRecoveredRecordingReservation).toHaveBeenCalledTimes(1);
    expect(
      getMeetingInterruptionCheckpoints().some((c) => c.meeting === meeting),
    ).toBe(false);
    await reconcileRecoveredMeeting(claim);
    expect(reconcileRecoveredRecordingReservation).toHaveBeenCalledTimes(1);
  },
);

test.each([
  "children",
  "voice",
  "notice",
  "nickname",
  "newer_owner",
  "newer_local",
])("uncertain original effects remain held: %s", async (unknown) => {
  const { local, meeting, claim } = fixture();
  if (unknown === "children")
    jest.mocked(fenceAndSettleSessionWork).mockResolvedValueOnce(false);
  if (unknown === "voice") {
    jest.mocked(settleOwnedVoiceSession).mockResolvedValue("uncertain");
    jest
      .mocked(whenOwnedVoiceSettled)
      .mockImplementation(() => new Promise<void>(() => {}));
  }
  if (unknown === "notice")
    jest.mocked(areMeetingNoticesSettled).mockReturnValue(false);
  if (unknown === "nickname")
    jest.mocked(restoreVoiceSessionNickname).mockResolvedValueOnce(false);
  if (unknown === "newer_local")
    jest.mocked(getMeeting).mockReturnValue({
      guildId: meeting.guildId,
      meetingId: "newer",
      finished: false,
    } as MeetingData);
  if (unknown === "newer_owner")
    jest.mocked(getDeploymentControlRepository).mockReturnValue({
      getMeetingHistory: async () => claim.history,
      getRecoveryLease: async () => ({
        ...claim.lease,
        recoveryAttemptId: "newer",
      }),
    } as never);
  const { original } = await expireOriginalFailure(meeting);
  await original;
  local.resolve();
  await prepareRecoveredMeeting(claim, new AbortController().signal, (run) =>
    run(),
  );
  await reconcileRecoveredMeeting(claim);
  expect(meeting.finished).not.toBe(true);
  expect(reconcileRecoveredRecordingReservation).not.toHaveBeenCalled();
  expect(
    getMeetingInterruptionCheckpoints().some((c) => c.meeting === meeting),
  ).toBe(true);
  jest.mocked(areMeetingNoticesSettled).mockReturnValue(true);
});

test.each([false, true])(
  "pending original initialization and nickname effects respect recovery authority: %s",
  async (loseAuthority) => {
    const { local, meeting, claim } = fixture();
    meeting.botNicknameChanged = false;
    const initialization = held();
    const actualInitialization = initialization.promise.then(() => {
      meeting.botNicknameChanged = true;
    });
    jest.mocked(getPendingMeetingInitializations).mockReturnValueOnce([
      {
        id: "guild:meeting",
        promise: actualInitialization,
        signal: new AbortController().signal,
      },
    ] as never);
    const { original } = await expireOriginalFailure(meeting);
    await original;
    local.resolve();
    const owner = new AbortController();
    const preparation = prepareRecoveredMeeting(claim, owner.signal, (run) =>
      run(),
    );
    let preparationFinished = false;
    void preparation.then(() => {
      preparationFinished = true;
    });
    await jest.advanceTimersByTimeAsync(1);
    expect(preparationFinished).toBe(false);
    expect(restoreVoiceSessionNickname).not.toHaveBeenCalled();
    if (loseAuthority) owner.abort();
    initialization.resolve();
    await preparation;
    await reconcileRecoveredMeeting(claim);
    expect(restoreVoiceSessionNickname).toHaveBeenCalledTimes(
      loseAuthority ? 0 : 1,
    );
    expect(meeting.finished === true).toBe(!loseAuthority);
  },
);
test("a successful renewal during lease read preserves exact cleanup authority", async () => {
  const { local, meeting, claim } = fixture();
  jest.mocked(getDeploymentControlRepository).mockReturnValue({
    getMeetingHistory: async () => claim.history,
    getRecoveryLease: async () => {
      const observed = structuredClone(claim.lease);
      claim.lease = {
        ...claim.lease,
        leaseExpiresAt: claim.lease.leaseExpiresAt + 10,
        updatedAt: "renewed",
      };
      return observed;
    },
  } as never);
  const { original } = await expireOriginalFailure(meeting);
  await original;
  local.resolve();
  await prepareRecoveredMeeting(claim, new AbortController().signal, (run) =>
    run(),
  );
  expect(meeting.botNicknameChanged).toBe(false);
  await reconcileRecoveredMeeting(claim);
  expect(meeting.finished).toBe(true);
});
test.each([false, true])(
  "late terminal acknowledgment revisits despite an expiring joined attempt: %s",
  async (raceExpiry) => {
    const { local, meeting, claim } = fixture();
    meeting.botNicknameChanged = false;
    const { original } = await expireOriginalFailure(meeting);
    await original;
    const cleanup = failedInitializationRuntime({
      getMeeting,
      deleteMeeting,
      stopMeetingProcessing: async () => {},
      areMeetingNoticesSettled,
      closeFailedInitializationOutput: async () => true,
    });
    jest.mocked(deleteMeeting).mockImplementation(() => {
      jest.mocked(getMeeting).mockReturnValue(undefined);
    });
    expect(await cleanup.dispose(meeting)).toBe(true);
    expect(meeting.finished).toBe(true);
    expect(getMeeting(meeting.guildId)).toBeUndefined();
    const checkpoint = getMeetingInterruptionCheckpoints().find(
      (entry) => entry.meeting === meeting,
    )!;
    const preparation = prepareRecoveredMeeting(
      claim,
      new AbortController().signal,
      (run) => run(),
    );
    await jest.advanceTimersByTimeAsync(30000);
    await preparation;
    const acknowledgment = reconcileRecoveredMeeting(claim);
    if (raceExpiry) {
      jest.advanceTimersByTime(30000);
      local.resolve();
    } else {
      await jest.advanceTimersByTimeAsync(30000);
      await acknowledgment;
      expect(reconcileRecoveredRecordingReservation).not.toHaveBeenCalled();
      local.resolve();
    }
    await acknowledgment;
    await jest.advanceTimersByTimeAsync(0);
    expect(meeting.finished).toBe(true);
    expect(reconcileRecoveredRecordingReservation).toHaveBeenCalledTimes(1);
    expect(checkpoint.deadline).toBe(1010);
    expect(checkpoint.signal.aborted).toBe(true);
    expect(await original).toEqual({ kind: "unresolved" });
  },
);

test.each([true, false])(
  "late verified voice and acknowledged recovery release in either order: %s",
  async (voiceFirst) => {
    const { local, meeting, claim } = fixture();
    const voice = held();
    let settled = false;
    jest.mocked(whenOwnedVoiceSettled).mockReturnValueOnce(voice.promise);
    jest
      .mocked(settleOwnedVoiceSession)
      .mockImplementation(async () => (settled ? "settled" : "uncertain"));
    const { original } = await expireOriginalFailure(meeting);
    await original;
    local.resolve();
    await jest.advanceTimersByTimeAsync(0);
    await prepareRecoveredMeeting(claim, new AbortController().signal, (run) =>
      run(),
    );
    expect(meeting.botNicknameChanged).toBe(false);
    expect(reconcileRecoveredRecordingReservation).not.toHaveBeenCalled();
    const before = structuredClone(claim.history);
    if (voiceFirst) {
      settled = true;
      voice.resolve();
      await jest.advanceTimersByTimeAsync(0);
    }
    await reconcileRecoveredMeeting(claim);
    if (!voiceFirst) {
      expect(meeting.finished).not.toBe(true);
      settled = true;
      voice.resolve();
    }
    await jest.advanceTimersByTimeAsync(0);
    expect(meeting.finished).toBe(true);
    expect(meeting.setFinished).toHaveBeenCalledTimes(1);
    expect(reconcileRecoveredRecordingReservation).toHaveBeenCalledTimes(1);
    expect(claim.history).toEqual(before);
  },
);
