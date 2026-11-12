/** @jest-environment node */
// Re-homed from meetingNoticeOwnership.test.ts, whose other cases drive the old interruption services.
import "../deployment/coldNetworkGuard.cjs";
import { getGuildLimits } from "../../src/services/subscriptionService";
import type { MeetingData } from "../../src/types/meeting-data";
import { updateMeetingProcessingMessage } from "../../src/embed";
import {
  notifyRecordingLimit,
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

function held<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function fixture() {
  const edit = jest.fn(async () => undefined);
  const message = { id: "synthetic-message", edit };
  const fetch = jest.fn(async () => message);
  const send = jest.fn(async () => message);
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
    setFinished: jest.fn(),
  } as unknown as MeetingData;
  return { meeting, edit, fetch, send };
}

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

beforeEach(() => jest.clearAllMocks());

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
