/** @jest-environment node */
import { matchesPublicationSnapshot } from "../../src/types/meetingPublication";
import type { MeetingData } from "../../src/types/meeting-data";
import type { MeetingHistory } from "../../src/types/db";
import type { HistoryTransition } from "../../src/types/deploymentControl";
import {
  beginRecordingDelivery,
  acknowledgeRecordingDeliveryMessage,
  finishRecordingDeliveryMutations,
  acknowledgeRecordingDeliveryHistory,
} from "../../src/services/recordingDeliveryService";
const mockRepository = {
  getMeetingHistory: jest.fn(),
  transitionMeetingHistory: jest.fn(),
};
jest.mock("../../src/db", () => ({
  getDeploymentControlRepository: () => mockRepository,
}));
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
  const meeting = {
    guildId: original.guildId,
    meetingId: original.meetingId,
    reservation: original,
    textChannel: { id: "text" },
  } as unknown as MeetingData;
  const row = {
    ...original,
    ...original.historyKey,
    status: "processing",
    checkpoint: { revision: 3 },
  } as unknown as MeetingHistory;
  mockRepository.getMeetingHistory.mockImplementation(async () =>
    structuredClone(row),
  );
  mockRepository.transitionMeetingHistory.mockImplementation(
    async (input: HistoryTransition) => {
      Object.assign(row, input.patch);
      return "applied";
    },
  );
  return { meeting, row };
}
beforeEach(() => jest.resetAllMocks());
test("lost pre-intent acknowledgment never authorizes delivery replay", async () => {
  const { meeting, row } = fixture();
  mockRepository.transitionMeetingHistory.mockImplementationOnce(
    async (input) => {
      Object.assign(row, input.patch);
      throw new Error("synthetic lost ACK");
    },
  );
  await expect(beginRecordingDelivery(meeting)).rejects.toThrow();
  expect(row.recovery).toMatchObject({
    stage: "delivery",
    disposition: "needs_reconciliation",
    reason: "delivery_uncertain",
    executionVersion: 1,
  });
  await expect(beginRecordingDelivery({ ...meeting })).rejects.toThrow();
  expect(mockRepository.transitionMeetingHistory).toHaveBeenCalledTimes(1);
});
test("partial acknowledged IDs remain durable and whole delivery clears only after terminal history ACK", async () => {
  const { meeting, row } = fixture();
  await beginRecordingDelivery(meeting);
  await acknowledgeRecordingDeliveryMessage(meeting, "summary", "summary-id");
  await acknowledgeRecordingDeliveryMessage(meeting, "notes", "notes-id");
  expect(row).toMatchObject({
    summaryMessageId: "summary-id",
    notesMessageIds: ["notes-id"],
    notesChannelId: "text",
    recovery: { disposition: "needs_reconciliation" },
  });
  await expect(acknowledgeRecordingDeliveryHistory(meeting)).rejects.toThrow();
  finishRecordingDeliveryMutations(meeting);
  await expect(acknowledgeRecordingDeliveryHistory(meeting)).rejects.toThrow();
  row.status = "complete";
  await acknowledgeRecordingDeliveryHistory(meeting);
  expect(row.recovery).toMatchObject({
    disposition: "done",
    stage: "delivery",
    outcome: "completed",
  });
  expect(
    mockRepository.transitionMeetingHistory.mock.calls.every(
      ([input]) =>
        input.recordingDelivery.ownership.voiceOperationAttemptId === "voice" &&
        input.expectedCheckpointRevision === 3 &&
        input.signal,
    ),
  ).toBe(true);
});
test("unknown ID checkpoint stops later delivery and never discards known IDs", async () => {
  const { meeting, row } = fixture();
  await beginRecordingDelivery(meeting);
  await acknowledgeRecordingDeliveryMessage(meeting, "notes", "first");
  mockRepository.transitionMeetingHistory.mockRejectedValueOnce(
    new Error("unknown metadata"),
  );
  await expect(
    acknowledgeRecordingDeliveryMessage(meeting, "notes", "second"),
  ).rejects.toThrow();
  expect(row.notesMessageIds).toEqual(["first"]);
  expect(row.recovery).toMatchObject({
    disposition: "needs_reconciliation",
    reason: "delivery_uncertain",
  });
});

test("lost final metadata ACK resolves only exact durable readback", async () => {
  const { meeting, row } = fixture();
  await beginRecordingDelivery(meeting);
  await acknowledgeRecordingDeliveryMessage(meeting, "summary", "summary-id");
  finishRecordingDeliveryMutations(meeting);
  row.status = "complete";
  mockRepository.transitionMeetingHistory.mockImplementationOnce(
    async (input) => {
      Object.assign(row, input.patch);
      throw new Error("lost done ACK");
    },
  );
  await expect(
    acknowledgeRecordingDeliveryHistory(meeting),
  ).resolves.toBeUndefined();
  expect(row.recovery?.disposition).toBe("done");
});
test("unknown final metadata outcome retains the durable delivery marker", async () => {
  const { meeting, row } = fixture();
  await beginRecordingDelivery(meeting);
  await acknowledgeRecordingDeliveryMessage(meeting, "summary", "summary-id");
  finishRecordingDeliveryMutations(meeting);
  row.status = "complete";
  mockRepository.transitionMeetingHistory.mockRejectedValueOnce(
    new Error("unknown done write"),
  );
  await expect(acknowledgeRecordingDeliveryHistory(meeting)).rejects.toThrow();
  expect(row.recovery).toMatchObject({
    disposition: "needs_reconciliation",
    reason: "delivery_uncertain",
  });
});

test("a definite stale lease result cannot be converted to ACK by matching old metadata", async () => {
  const { meeting } = fixture();
  await beginRecordingDelivery(meeting);
  await acknowledgeRecordingDeliveryMessage(meeting, "notes", "first");
  mockRepository.transitionMeetingHistory.mockResolvedValueOnce("stale");
  await expect(
    acknowledgeRecordingDeliveryMessage(meeting, "notes", "first"),
  ).rejects.toThrow("fenced");
});

test("rejects notes timing from a stale original owner", async () => {
  const { meeting, row } = fixture();
  await beginRecordingDelivery(meeting);
  row.ownerInstanceId = "replacement";
  await expect(
    acknowledgeRecordingDeliveryMessage(meeting, "notes", "notes", {
      kind: "complete",
      notesVersion: 1,
      path: "live",
      firstAcknowledgedAt: "2026-10-16T12:00:30.000Z",
      completeAcknowledgedAt: "2026-10-16T12:00:30.000Z",
    }),
  ).rejects.toThrow("ownership changed");
  expect(row.notesDeliveryTiming).toBeUndefined();
});

test("omits invalid timing from an existing notes acknowledgement write", async () => {
  const { meeting, row } = fixture();
  const first = {
    kind: "first",
    notesVersion: 1,
    path: "live",
    firstAcknowledgedAt: "2026-10-16T12:00:30.000Z",
  } as const;
  row.notesDeliveryTiming = first;
  meeting.notesDeliveryTiming = first;
  await beginRecordingDelivery(meeting);
  await acknowledgeRecordingDeliveryMessage(
    meeting,
    "notes",
    "notes",
    JSON.parse('{"kind":"first","firstAcknowledgedAt":"bad"}'),
  );
  expect(row.notesMessageIds).toEqual(["notes"]);
  expect(row.notesDeliveryTiming).toEqual(first);
  expect(meeting.notesDeliveryTiming).toEqual(first);
  const input = mockRepository.transitionMeetingHistory.mock.calls.at(-1)![0];
  expect(input.patch).not.toHaveProperty("notesDeliveryTiming");
  expect(input.recordingDelivery.previous.notesDeliveryTiming).toEqual(first);
});

test("uncertain timing write must match the exact durable timing before continuing", async () => {
  const { meeting, row } = fixture();
  await beginRecordingDelivery(meeting);
  const timing = {
    kind: "complete",
    notesVersion: 1,
    path: "live",
    firstAcknowledgedAt: "2026-10-16T12:00:30.000Z",
    completeAcknowledgedAt: "2026-10-16T12:00:45.000Z",
  } as const;
  mockRepository.transitionMeetingHistory.mockImplementationOnce(
    async (input) => {
      Object.assign(row, input.patch, { notesDeliveryTiming: undefined });
      throw new Error("timing not committed");
    },
  );
  await expect(
    acknowledgeRecordingDeliveryMessage(meeting, "notes", "notes", timing),
  ).rejects.toThrow("timing not committed");
  expect(row.notesMessageIds).toEqual(["notes"]);
});

function advanceCanonical(row: MeetingHistory) {
  const revision = (row.contentRevision ?? 0) + 1;
  Object.assign(row, {
    contentRevision: revision,
    meetingName: "Edited " + revision,
    contentMutation: {
      id: "edit-" + revision,
      fingerprint: "a".repeat(64),
      fieldRevisions: { meetingName: revision },
    },
  });
}
test.each(["intent", "summary", "notes", "terminal"] as const)(
  "retries only canonical conflicts for %s with original metadata",
  async (phase) => {
    const { meeting, row } = fixture();
    if (phase !== "intent") await beginRecordingDelivery(meeting);
    if (phase === "terminal") {
      finishRecordingDeliveryMutations(meeting);
      row.status = "complete";
    }
    mockRepository.transitionMeetingHistory.mockClear();
    const patches: HistoryTransition["patch"][] = [];
    mockRepository.transitionMeetingHistory.mockImplementation(
      async (input: HistoryTransition) => {
        patches.push(input.patch);
        if (patches.length <= 2) advanceCanonical(row);
        if (
          !input.expectedPublication ||
          !matchesPublicationSnapshot(
            structuredClone(row),
            input.expectedPublication,
          )
        )
          return "stale";
        Object.assign(row, input.patch);
        return "applied";
      },
    );
    const work =
      phase === "intent"
        ? beginRecordingDelivery(meeting)
        : phase === "terminal"
          ? acknowledgeRecordingDeliveryHistory(meeting)
          : acknowledgeRecordingDeliveryMessage(meeting, phase, "accepted-id");
    await expect(work).resolves.toBeUndefined();
    expect(patches).toHaveLength(3);
    expect(patches[1]).toEqual(patches[0]);
    expect(patches[2]).toEqual(patches[0]);
    expect(row.meetingName).toBe("Edited 2");
    if (phase === "summary") expect(row.summaryMessageId).toBe("accepted-id");
    if (phase === "notes") expect(row.notesMessageIds).toEqual(["accepted-id"]);
  },
);
test("caps canonical metadata recovery at three transitions and three reads", async () => {
  const { meeting, row } = fixture();
  mockRepository.transitionMeetingHistory.mockImplementation(
    async (input: HistoryTransition) => {
      advanceCanonical(row);
      expect(
        matchesPublicationSnapshot(
          structuredClone(row),
          input.expectedPublication!,
        ),
      ).toBe(false);
      return "stale";
    },
  );
  await expect(beginRecordingDelivery(meeting)).rejects.toThrow("fenced");
  expect(mockRepository.transitionMeetingHistory).toHaveBeenCalledTimes(3);
  expect(mockRepository.getMeetingHistory).toHaveBeenCalledTimes(3);
});
test.each([
  { status: "complete" },
  { ownerInstanceId: "other" },
  { executionVersion: 2 },
  "checkpoint",
  { summaryMessageId: "other" },
  { notesMessageIds: ["other"] },
  { notesChannelId: "other" },
  {
    delivery: {
      summary: { outcome: "failed", intended: 1, sent: 0, errors: [] },
    },
  },
] satisfies (Partial<MeetingHistory> | "checkpoint")[])(
  "does not adopt a mixed canonical/noncanonical conflict %j",
  async (change) => {
    const { meeting, row } = fixture();
    mockRepository.transitionMeetingHistory.mockImplementationOnce(async () => {
      advanceCanonical(row);
      if (change === "checkpoint")
        row.checkpoint = { ...row.checkpoint!, revision: 4 };
      else Object.assign(row, change);
      return "stale";
    });
    await expect(beginRecordingDelivery(meeting)).rejects.toThrow();
    expect(mockRepository.transitionMeetingHistory).toHaveBeenCalledTimes(1);
  },
);
