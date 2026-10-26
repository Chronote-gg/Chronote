/** @jest-environment node */
jest.mock("../../src/services/configService", () => ({
  config: { frontend: { siteUrl: "https://example.invalid" } },
}));
jest.mock("../../src/commands/summaryFeedback", () => ({
  buildSummaryFeedbackButtonIds: () => ({ up: "up", down: "down" }),
}));
jest.mock("../../src/commands/meetingName", () => ({
  MEETING_RENAME_PREFIX: "rename",
}));
jest.mock("../../src/services/summaryUpgradeService", () => ({
  claimSummaryUpgrade: async () => undefined,
}));
jest.mock("../../src/services/analyticsService", () => ({
  captureEvent: jest.fn(),
}));
jest.mock("../../src/services/langfuseClient", () => ({
  isLangfuseTracingEnabled: () => false,
}));
jest.mock("@langfuse/tracing", () => ({ updateActiveObservation: jest.fn() }));
const mockRepository = {
  getMeetingHistory: jest.fn(),
  transitionMeetingHistory: jest.fn(),
};
jest.mock("../../src/db", () => ({
  getDeploymentControlRepository: () => mockRepository,
}));
import { updateMeetingSummaryMessage } from "../../src/embed";
import { acknowledgeRecordingDeliveryHistory } from "../../src/services/recordingDeliveryService";
import type { MeetingData } from "../../src/types/meeting-data";
import type { MeetingHistory } from "../../src/types/db";
function fixture() {
  const original = {
    guildId: "synthetic",
    meetingId: "synthetic",
    ownerInstanceId: "owner",
    executionVersion: 1,
    voiceOperationAttemptId: "voice",
    sessionMode: "meeting",
    historyKey: { guildId: "synthetic", channelId_timestamp: "voice#start" },
  };
  const edit = jest.fn(async () => undefined);
  const send = jest.fn();
  const meeting = {
    ...original,
    reservation: original,
    creator: { id: "synthetic" },
    startMessageId: "summary",
    startTime: new Date(0),
    endTime: new Date(120000),
    attendance: new Set(),
    voiceChannel: { id: "voice", name: "Voice" },
    textChannel: {
      id: "text",
      messages: { fetch: jest.fn(async () => ({ id: "summary", edit })) },
      send,
    },
    generateNotes: true,
    notesText: "A".repeat(5900),
    summarySentence: "Synthetic",
    processing: { transcription: "partial", notes: "generated" },
  } as unknown as MeetingData;
  const row = {
    ...original,
    status: "processing",
    checkpoint: { revision: 3 },
  } as unknown as MeetingHistory;
  mockRepository.getMeetingHistory.mockImplementation(async () =>
    structuredClone(row),
  );
  mockRepository.transitionMeetingHistory.mockImplementation(async (input) => {
    Object.assign(row, input.patch);
    return "applied";
  });
  return { meeting, row, edit, send };
}
beforeEach(() => jest.resetAllMocks());
test("held and lost pre-intent ACK issues zero Discord mutations", async () => {
  const { meeting, row, edit, send } = fixture();
  let release!: () => void;
  mockRepository.transitionMeetingHistory.mockImplementationOnce(
    async (input) => {
      await new Promise<void>((done) => {
        release = done;
      });
      Object.assign(row, input.patch);
      throw new Error("lost intent ACK");
    },
  );
  const actual = updateMeetingSummaryMessage(meeting, { finalization: true });
  const outcome = actual.catch(() => "unknown");
  await new Promise<void>((done) => setImmediate(done));
  expect(edit).not.toHaveBeenCalled();
  expect(send).not.toHaveBeenCalled();
  release();
  await outcome;
  expect(edit).not.toHaveBeenCalled();
  expect(send).not.toHaveBeenCalled();
  expect(row.recovery).toMatchObject({
    disposition: "needs_reconciliation",
    reason: "delivery_uncertain",
  });
});
test("partial batch lost send ACK retains known IDs and a restarted producer cannot replay", async () => {
  const { meeting, row, send } = fixture();
  send
    .mockResolvedValueOnce({ id: "first-notes" })
    .mockRejectedValueOnce(new Error("lost second send ACK"));
  await expect(
    updateMeetingSummaryMessage(meeting, { finalization: true }),
  ).rejects.toThrow("lost second");
  expect(row).toMatchObject({
    summaryMessageId: "summary",
    notesMessageIds: ["first-notes"],
    notesChannelId: "text",
    recovery: {
      stage: "delivery",
      disposition: "needs_reconciliation",
      reason: "delivery_uncertain",
    },
  });
  expect(send).toHaveBeenCalledTimes(2);
  await expect(
    updateMeetingSummaryMessage({ ...meeting }, { finalization: true }),
  ).rejects.toThrow("replayed");
  expect(send).toHaveBeenCalledTimes(2);
});
test("all actual message ACKs plus terminal history allow exact delivery done", async () => {
  const { meeting, row, send } = fixture();
  send
    .mockResolvedValueOnce({ id: "first-notes" })
    .mockResolvedValueOnce({ id: "second-notes" });
  await updateMeetingSummaryMessage(meeting, { finalization: true });
  expect(row.recovery?.disposition).toBe("needs_reconciliation");
  row.status = "complete";
  await acknowledgeRecordingDeliveryHistory(meeting);
  expect(row.notesMessageIds).toEqual(["first-notes", "second-notes"]);
  expect(row.recovery).toMatchObject({
    disposition: "done",
    outcome: "completed",
    stage: "delivery",
  });
});

afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

test("timestamps Discord acknowledgement before the durable write", async () => {
  jest.useFakeTimers();
  jest.setSystemTime(125000);
  const { meeting, row, send } = fixture();
  const firstAcknowledgedAt = new Date(150000).toISOString();
  const completeAcknowledgedAt = new Date(165000).toISOString();
  const getHistory = mockRepository.getMeetingHistory.getMockImplementation()!;
  mockRepository.getMeetingHistory.mockImplementation(async () => {
    jest.setSystemTime(Date.now() + 10000);
    return getHistory();
  });
  mockRepository.transitionMeetingHistory.mockImplementation(async (input) => {
    if (input.patch.summaryMessageId) {
      expect(input.patch.notesDeliveryTiming).toBeUndefined();
      expect(meeting.notesDeliveryTiming).toBeUndefined();
    }
    jest.setSystemTime(Date.now() + 10000);
    Object.assign(row, input.patch);
    return "applied";
  });
  send
    .mockImplementationOnce(async () => {
      jest.setSystemTime(150000);
      return { id: "first-notes" };
    })
    .mockImplementationOnce(async () => {
      expect(row.notesDeliveryTiming).toEqual({
        kind: "first",
        notesVersion: 1,
        path: "live",
        firstAcknowledgedAt,
      });
      jest.setSystemTime(165000);
      return { id: "second-notes" };
    });
  await updateMeetingSummaryMessage(meeting, { finalization: true });
  expect(meeting.notesDeliveryTiming).toEqual({
    kind: "complete",
    notesVersion: 1,
    path: "live",
    firstAcknowledgedAt,
    completeAcknowledgedAt,
  });
  expect(row.notesDeliveryTiming).toEqual(meeting.notesDeliveryTiming);
  expect(send).toHaveBeenCalledTimes(2);
  expect(mockRepository.transitionMeetingHistory).toHaveBeenCalledTimes(4);
});

test("retains first timing after a later batch fails", async () => {
  const { meeting, row, send } = fixture();
  send
    .mockResolvedValueOnce({ id: "first-notes" })
    .mockRejectedValueOnce(new Error("second batch failed"));
  await expect(
    updateMeetingSummaryMessage(meeting, { finalization: true }),
  ).rejects.toThrow("second batch failed");
  expect(meeting.notesDeliveryTiming?.kind).toBe("first");
  expect(row.notesDeliveryTiming).toEqual(meeting.notesDeliveryTiming);
  expect(row.recovery?.disposition).toBe("needs_reconciliation");
  expect(send).toHaveBeenCalledTimes(2);
});

test.each([
  ["never resends after an uncertain acknowledgement", false],
  [
    "accepts exact durable timing after a lost acknowledgement without resending",
    true,
  ],
] as const)("%s", async (_name, committed) => {
  const { meeting, row, send } = fixture();
  meeting.notesText = "One batch";
  send.mockResolvedValueOnce({ id: "notes" });
  mockRepository.transitionMeetingHistory.mockImplementation(async (input) => {
    if (input.patch.notesMessageIds) {
      if (committed) Object.assign(row, input.patch);
      throw new Error("uncertain notes metadata");
    }
    Object.assign(row, input.patch);
    return "applied";
  });
  const actual = updateMeetingSummaryMessage(meeting, { finalization: true });
  if (committed) await expect(actual).resolves.toBeDefined();
  else await expect(actual).rejects.toThrow("uncertain notes metadata");
  expect(meeting.notesDeliveryTiming?.kind).toBe("complete");
  expect(row.notesDeliveryTiming?.kind).toBe(
    committed ? "complete" : undefined,
  );
  expect(row.recovery?.disposition).toBe("needs_reconciliation");
  expect(send).toHaveBeenCalledTimes(1);
  await expect(
    updateMeetingSummaryMessage({ ...meeting }, { finalization: true }),
  ).rejects.toThrow("replayed");
  expect(send).toHaveBeenCalledTimes(1);
});

test("malformed optional legacy timing does not prevent live delivery", async () => {
  const { meeting, row, send } = fixture();
  Object.assign(meeting, { notesDeliveryTiming: { kind: "legacy" } });
  Object.assign(row, { notesDeliveryTiming: { kind: "legacy" } });
  meeting.notesText = "One batch";
  send.mockResolvedValue({ id: "notes" });
  await expect(
    updateMeetingSummaryMessage(meeting, { finalization: true }),
  ).resolves.toBeDefined();
  expect(row.notesDeliveryTiming?.kind).toBe("complete");
  expect(send).toHaveBeenCalledTimes(1);
});

test("an invalid later clock retains the valid first observation", async () => {
  jest.useFakeTimers();
  const { meeting, row, send } = fixture();
  send
    .mockImplementationOnce(async () => {
      jest.setSystemTime(165000);
      return { id: "first-notes" };
    })
    .mockImplementationOnce(async () => {
      jest.setSystemTime(150000);
      return { id: "second-notes" };
    });
  await updateMeetingSummaryMessage(meeting, { finalization: true });
  expect(row.notesDeliveryTiming).toEqual({
    kind: "first",
    notesVersion: 1,
    path: "live",
    firstAcknowledgedAt: new Date(165000).toISOString(),
  });
  expect(meeting.notesDeliveryTiming).toEqual(row.notesDeliveryTiming);
});
