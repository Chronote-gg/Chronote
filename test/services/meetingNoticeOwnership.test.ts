/** @jest-environment node */
import "../deployment/coldNetworkGuard.cjs";
import { DiscordAPIError, EmbedBuilder } from "discord.js";
import { getGuildLimits } from "../../src/services/subscriptionService";
import type { MeetingData } from "../../src/types/meeting-data";
import {
  updateMeetingMessage,
  updateMeetingProcessingMessage,
} from "../../src/embed";
import { interruptOwnedMeeting } from "../../src/services/ownedMeetingInterruption";
import { reconcilePreservedRecordingReservation } from "../../src/services/activeMeetingLeaseService";
import {
  notifyRecordingLimit,
  type RecordingLimitState,
  type RecordingLimitInput,
} from "../../src/services/recordingLimitService";
const mockLimitLookup = jest.fn(async () => undefined);
jest.mock("../../src/repositories/subscriptionRepository", () => ({
  getSubscriptionRepository: () => ({ get: mockLimitLookup }),
}));
jest.mock("../../src/services/subscriptionService", () => ({
  getGuildLimits: jest.fn(),
  getLimitsForTier: () => ({ maxMeetingMinutesRolling: 1000 }),
}));
const mockHistory = jest.fn();
jest.mock("../../src/commands/summaryFeedback", () => ({
  buildSummaryFeedbackButtonIds: jest.fn(),
}));
jest.mock("../../src/commands/meetingName", () => ({
  MEETING_RENAME_PREFIX: "synthetic",
}));
jest.mock("../../src/services/summaryUpgradeService", () => ({
  claimSummaryUpgrade: jest.fn(),
}));
jest.mock("../../src/services/analyticsService", () => ({
  captureEvent: jest.fn(),
}));
jest.mock("../../src/observability/meetingDelivery", () => ({
  recordDelivery: (_meeting: unknown, _phase: unknown, result: unknown) =>
    result,
  deliveryError: () => ({ name: "SyntheticError" }),
}));
jest.mock("../../src/audio", () => ({
  closeOutputFile: async () => {},
  waitForCaptureStreamSettlement: async () => {},
}));
jest.mock("../../src/commands/endMeeting", () => ({
  fenceMeetingFinalization: (meeting: MeetingData) =>
    meeting.finalization!.controller.abort(),
}));
jest.mock("../../src/meetings", () => ({
  getPendingMeetingInitializations: () => [],
  getMeeting: jest.fn(),
  deleteMeeting: jest.fn(),
  restoreVoiceSessionNickname: async () => true,
}));
jest.mock("../../src/services/runtimeWorkAdmissionService", () => ({
  fenceAndSettleSessionWork: async () => true,
}));
jest.mock("../../src/services/guildVoiceOperationService", () => ({
  settleOwnedVoiceSession: async () => "settled",
  waitOwnedVoiceEffects: async () => {},
}));
jest.mock("../../src/services/activeMeetingLeaseService", () => ({
  reconcilePreservedRecordingReservation: jest.fn(async () => true),
  reconcilePreservedTtsReservation: jest.fn(),
}));
jest.mock("../../src/db", () => ({
  getActiveMeetingLease: jest.fn(),
  getDeploymentControlRepository: () => ({ getMeetingHistory: mockHistory }),
}));
jest.mock("../../src/services/recordingCheckpointService", () => ({
  createRecordingCheckpointService: () => ({
    preserveInitialTerminalRecordingCheckpoint: async () => ({
      kind: "committed",
      checkpoint: { revision: 1 },
    }),
  }),
}));
function held<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, failed) => {
    resolve = done;
    reject = failed;
  });
  return { promise, resolve, reject };
}
function fixture() {
  const edit = jest.fn(async () => undefined);
  const message = { id: "synthetic-message", edit };
  const fetch = jest.fn(async () => message);
  const send = jest.fn(async () => message);
  const reservation = {
    guildId: "synthetic",
    meetingId: "synthetic",
    ownerInstanceId: "original",
    executionVersion: 1,
    voiceOperationAttemptId: "original",
    sessionMode: "meeting",
    reservedAt: 0,
    historyKey: { guildId: "synthetic", channelId_timestamp: "voice#start" },
  };
  const meeting = {
    guildId: "synthetic",
    meetingId: "synthetic",
    channelId: "separate-notes",
    startMessageId: message.id,
    startTime: new Date(0),
    endTime: new Date(1000),
    attendance: new Set(),
    voiceChannel: { id: "voice", name: "Synthetic" },
    textChannel: { id: "separate-notes", messages: { fetch }, send },
    audioData: {},
    reservation,
    finalization: {
      controller: new AbortController(),
      promise: Promise.resolve(),
      disposition: "running",
    },
    recordingCaptureState: {
      kind: "interrupted",
      startedAt: new Date(0).toISOString(),
      detectedAt: new Date(1000).toISOString(),
      endedAt: new Date(1000).toISOString(),
    },
    setFinished: jest.fn(),
  } as unknown as MeetingData;
  mockHistory.mockResolvedValue({ ...reservation, status: "processing" });
  return { meeting, edit, fetch, send, message };
}
function notice(meeting: MeetingData, phase: "processing" | "cancellation") {
  return phase === "processing"
    ? updateMeetingProcessingMessage(meeting)
    : updateMeetingMessage(
        meeting,
        {
          embeds: [new EmbedBuilder().setDescription("Synthetic cancellation")],
        },
        phase,
      );
}
const stop = (meeting: MeetingData) =>
  interruptOwnedMeeting(meeting, {
    reason: "shutdown",
    deadline: Date.now() + 100000,
  });
beforeEach(() => jest.clearAllMocks());
test.each(["processing", "cancellation"] as const)(
  "owned %s held fetch is counted and cannot dispatch after fencing",
  async (phase) => {
    const f = fixture();
    const lookup = held<typeof f.message>();
    const entered = held<void>();
    f.fetch.mockImplementationOnce(() => {
      entered.resolve();
      return lookup.promise;
    });
    const task = notice(f.meeting, phase).catch((error) => error);
    await entered.promise;
    let settled = false;
    const stopping = stop(f.meeting).then((result) => {
      settled = true;
      return result;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    const before = settled;
    lookup.resolve(f.message);
    await task;
    expect(await stopping).toEqual({ kind: "settled" });
    expect(before).toBe(false);
    expect(f.edit).not.toHaveBeenCalled();
    expect(f.send).not.toHaveBeenCalled();
  },
);
test.each(["processing", "cancellation"] as const)(
  "owned %s held edit retains actual tail and unknown outcome without fallback",
  async (phase) => {
    const f = fixture();
    const mutation = held<void>();
    const entered = held<void>();
    f.edit.mockImplementationOnce(() => {
      entered.resolve();
      return mutation.promise;
    });
    const task = notice(f.meeting, phase).catch((error) => error);
    await entered.promise;
    let settled = false;
    const stopping = stop(f.meeting).then((result) => {
      settled = true;
      return result;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    const before = settled;
    mutation.reject(new Error("Synthetic lost edit ACK"));
    await task;
    expect(await stopping).toEqual({ kind: "unresolved" });
    expect(before).toBe(false);
    expect(f.send).not.toHaveBeenCalled();
    expect(reconcilePreservedRecordingReservation).not.toHaveBeenCalled();
  },
);
test.each(["edit", "send"] as const)(
  "lost %s ACK remains owned even before an external fence and after later known notice",
  async (operation) => {
    const f = fixture();
    if (operation === "edit")
      f.edit.mockRejectedValueOnce(new Error("Synthetic lost ACK"));
    else {
      f.meeting.startMessageId = undefined;
      f.send.mockRejectedValueOnce(new Error("Synthetic lost ACK"));
    }
    const first = await notice(f.meeting, "processing").catch((error) => error);
    // A later acknowledged unrelated preservation notification cannot erase the earlier uncertainty.
    f.meeting.recordingPreservationNotification = {
      promise: Promise.resolve(),
      outcome: "acknowledged",
    };
    await notice(f.meeting, "cancellation").catch(() => {});
    expect(first).toBeInstanceOf(Error);
    expect(f.edit.mock.calls.length + f.send.mock.calls.length).toBe(1);
    expect(await stop(f.meeting)).toEqual({ kind: "unresolved" });
    expect(reconcilePreservedRecordingReservation).not.toHaveBeenCalled();
  },
);
test("explicit missing edit allows one fallback while the original owner is active", async () => {
  const f = fixture();
  f.edit.mockRejectedValueOnce(
    new DiscordAPIError(
      { code: 10008, message: "Synthetic missing" },
      10008,
      404,
      "PATCH",
      "http://localhost",
      { json: {}, files: [] },
    ),
  );
  await notice(f.meeting, "processing");
  expect(f.send).toHaveBeenCalledTimes(1);
  expect(await stop(f.meeting)).toEqual({ kind: "settled" });
});

const minutesInput: RecordingLimitInput = {
  guildId: "synthetic",
  limitType: "weekly_recording",
  limitSurface: "weekly_after_meeting",
  outcome: "exhausted_after_meeting",
  limitMinutes: 60,
  usedMinutes: 60,
  message: "Synthetic minutes notice",
  resolved: {
    limits: { maxMeetingMinutesRolling: 60 },
    subscription: { tier: "free", source: "default" },
  } as RecordingLimitInput["resolved"],
};
function minutes(
  f: ReturnType<typeof fixture>,
  state: RecordingLimitState,
  input = minutesInput,
) {
  f.meeting.recordingLimitNotice = state;
  return notifyRecordingLimit(input, f.meeting.textChannel, state, f.meeting);
}
test("owned minutes eligibility lookup cannot issue a late send and remains counted", async () => {
  const f = fixture();
  const lookup = held<undefined>();
  const entered = held<void>();
  mockLimitLookup.mockImplementationOnce(() => {
    entered.resolve();
    return lookup.promise;
  });
  const task = minutes(f, {}).catch((error) => error);
  await entered.promise;
  let settled = false;
  const stopping = stop(f.meeting).then((result) => {
    settled = true;
    return result;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  const before = settled;
  lookup.resolve(undefined);
  await task;
  expect(await stopping).toEqual({ kind: "settled" });
  expect(before).toBe(false);
  expect(f.send).not.toHaveBeenCalled();
});
test.each(["known", "lost"] as const)(
  "owned minutes held edit %s retains actual lifetime without fallback",
  async (outcome) => {
    const f = fixture();
    const mutation = held<void>();
    const entered = held<void>();
    f.edit.mockImplementationOnce(() => {
      entered.resolve();
      return mutation.promise;
    });
    const task = minutes(f, { message: f.message }).catch((error) => error);
    await entered.promise;
    let settled = false;
    const stopping = stop(f.meeting).then((result) => {
      settled = true;
      return result;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    const before = settled;
    if (outcome === "known") mutation.resolve();
    else mutation.reject(new Error("Synthetic minutes lost edit ACK"));
    await task;
    expect(await stopping).toEqual({
      kind: outcome === "known" ? "settled" : "unresolved",
    });
    expect(before).toBe(false);
    expect(f.send).not.toHaveBeenCalled();
  },
);
test("owned minutes lost send ACK throws and retains ownership without an external fence", async () => {
  const f = fixture();
  f.send.mockRejectedValueOnce(new Error("Synthetic minutes lost send ACK"));
  const result = await minutes(f, {}).catch((error) => error);
  expect(result).toBeInstanceOf(Error);
  expect(await stop(f.meeting)).toEqual({ kind: "unresolved" });
  expect(reconcilePreservedRecordingReservation).not.toHaveBeenCalled();
});

test.each(["acknowledged", "missing"] as const)(
  "owned notice held edit %s after fencing never falls back and has a known outcome",
  async (outcome) => {
    const f = fixture();
    const mutation = held<void>();
    const entered = held<void>();
    f.edit.mockImplementationOnce(() => {
      entered.resolve();
      return mutation.promise;
    });
    const task = notice(f.meeting, "processing").catch((error) => error);
    await entered.promise;
    const stopping = stop(f.meeting);
    if (outcome === "acknowledged") mutation.resolve();
    else
      mutation.reject(
        new DiscordAPIError(
          { code: 10008, message: "Synthetic missing" },
          10008,
          404,
          "PATCH",
          "http://localhost",
          { json: {}, files: [] },
        ),
      );
    await task;
    expect(await stopping).toEqual({ kind: "settled" });
    expect(f.send).not.toHaveBeenCalled();
  },
);

test("an ambiguous fetch failure cannot issue a fallback or invent a submitted mutation", async () => {
  const f = fixture();
  f.fetch.mockRejectedValueOnce(new Error("Synthetic read failure"));
  await expect(notice(f.meeting, "processing")).rejects.toThrow(
    "Synthetic read failure",
  );
  expect(f.edit).not.toHaveBeenCalled();
  expect(f.send).not.toHaveBeenCalled();
  expect(await stop(f.meeting)).toEqual({ kind: "settled" });
});

test("a known notice ACK cannot be transferred to a replacement reservation", async () => {
  const f = fixture();
  await notice(f.meeting, "processing");
  f.meeting.reservation = {
    ...f.meeting.reservation!,
    ownerInstanceId: "replacement",
  };
  expect(await stop(f.meeting)).toEqual({ kind: "unresolved" });
  expect(reconcilePreservedRecordingReservation).not.toHaveBeenCalled();
});

test("one failed eligibility read cannot hide its held sibling from the original owner", async () => {
  const f = fixture();
  const lookup = held<undefined>();
  const entered = held<void>();
  jest
    .mocked(getGuildLimits)
    .mockRejectedValueOnce(new Error("Synthetic limits read failure"));
  mockLimitLookup.mockImplementationOnce(() => {
    entered.resolve();
    return lookup.promise;
  });
  const task = minutes(f, {}, { ...minutesInput, resolved: undefined }).catch(
    (error) => error,
  );
  await entered.promise;
  let settled = false;
  const stopping = stop(f.meeting).then((result) => {
    settled = true;
    return result;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(settled).toBe(false);
  lookup.resolve(undefined);
  await task;
  expect(await stopping).toEqual({ kind: "settled" });
  expect(f.send).not.toHaveBeenCalled();
});

test("unrelated unsignaled notice keeps its early read-failure fallback", async () => {
  const f = fixture();
  const lookup = held<undefined>();
  jest
    .mocked(getGuildLimits)
    .mockRejectedValueOnce(new Error("Synthetic limits read failure"));
  mockLimitLookup.mockReturnValueOnce(lookup.promise);
  const task = notifyRecordingLimit(
    { ...minutesInput, resolved: undefined },
    f.meeting.textChannel,
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
  const callsBeforeReadSettled = f.send.mock.calls.length;
  lookup.resolve(undefined);
  await task;
  expect(callsBeforeReadSettled).toBe(1);
});

test("processing notification keeps the configured text destination separate from capture voice", async () => {
  const f = fixture();
  f.meeting.startMessageId = undefined;
  await updateMeetingProcessingMessage(f.meeting);
  expect(f.meeting.voiceChannel.id).toBe("voice");
  expect(f.meeting.channelId).toBe("separate-notes");
  expect(f.meeting.textChannel.id).toBe("separate-notes");
  expect(f.send).toHaveBeenCalledTimes(1);
  expect(f.fetch).not.toHaveBeenCalled();
  expect(f.edit).not.toHaveBeenCalled();
});
