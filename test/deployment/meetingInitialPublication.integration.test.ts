/** @jest-environment node */
import { featureCanonicalRecords } from "../services/meetingCanonicalPeers.fixture";
import { publicationHttpFixture } from "./meetingPublicationHttp.fixture";
import type { MeetingData } from "../../src/types/meeting-data";
import type { MeetingHistory } from "../../src/types/db";
import { publicationDynamoFixture } from "./meetingPublicationDynamo.fixture";
import { key, history } from "../types/meetingUpdateDelivery.fixture";
import {
  beginRecordingDelivery,
  acknowledgeRecordingDeliveryMessage,
  finishRecordingDeliveryMutations,
  acknowledgeRecordingDeliveryHistory,
} from "../../src/services/recordingDeliveryService";
import { saveOwnedMeetingHistoryService } from "../../src/services/meetingHistoryService";
import { updateMeeting } from "../../src/services/meetingUpdateService";
import { projectMeetingUpdateDelivery } from "../../src/services/meetingUpdateStatus";

let http: Awaited<ReturnType<typeof publicationHttpFixture>>;
let mockFixture: Awaited<ReturnType<typeof publicationDynamoFixture>>;
jest.mock("../../src/db", () => ({
  getDeploymentControlRepository: () => mockFixture.original,
  getMeetingUpdateDeliveryRepository: () => mockFixture.updates,
}));
jest.mock("../../src/repositories/meetingHistoryRepository", () => ({
  getMeetingHistoryRepository: () => ({
    getOwned: mockFixture.original.getMeetingHistory,
    transitionOwned: mockFixture.original.transitionMeetingHistory,
  }),
}));
jest.mock("../../src/services/meetingUserIndexService", () => ({
  writeMeetingUserIndexForMeetingService: jest.fn(),
}));
jest.mock("../../src/services/meetingUpdateDeliveryWorkerService", () => ({
  verifyMeetingUpdateDeliveryReadiness: async () => undefined,
}));
jest.mock("../../src/services/notionAutomationService", () => ({
  maybeAutoSyncMeetingNotes: async () => undefined,
}));

beforeEach(async () => {
  mockFixture = await publicationDynamoFixture();
  for (const row of featureCanonicalRecords().values())
    await mockFixture.put(mockFixture.tables.deploymentControl, row);
  http = await publicationHttpFixture({
    botId: "910001",
    guildId: key.guildId,
    channelId: "910002",
    messages: [],
  });
});
afterEach(async () => {
  try {
    await http.close();
  } finally {
    await mockFixture.close();
  }
});
function reservation() {
  return {
    ...key,
    guildId: key.guildId,
    meetingId: "synthetic-meeting",
    ownerInstanceId: "old",
    executionVersion: 1,
    voiceOperationAttemptId: "synthetic-original",
    sessionMode: "meeting" as const,
    historyKey: key,
  };
}
async function initialPublication(initiallyEmpty = false) {
  const original = reservation();
  const row: MeetingHistory = {
    ...history(),
    status: "processing",
    ownerInstanceId: original.ownerInstanceId,
    executionVersion: 1,
    canonicalWriter: {
      kind: "recording",
      ownerInstanceId: original.ownerInstanceId,
      executionVersion: 1,
    },
    checkpoint: { revision: 3 } as MeetingHistory["checkpoint"],
    notesVersion: 1,
    meetingName: "Generated name",
    summarySentence: "Generated summary",
    summaryLabel: "Generated label",
  };
  const stored = { ...row };
  if (initiallyEmpty)
    for (const field of [
      "notes",
      "notesVersion",
      "notesDelta",
      "notesHistory",
      "notesLastEditedBy",
      "notesLastEditedAt",
      "suggestionsHistory",
      "meetingName",
      "summarySentence",
      "summaryLabel",
    ] as const)
      Reflect.deleteProperty(stored, field);
  await mockFixture.put(mockFixture.tables.meetingHistory, stored);
  await mockFixture.put(mockFixture.tables.activeMeeting, {
    ...original,
    leaseExpiresAt: Math.floor(Date.now() / 1000) + 3600,
  });
  const meeting = {
    guildId: row.guildId,
    meetingId: row.meetingId,
    reservation: original,
    textChannel: { id: "910002" },
  } as unknown as MeetingData;
  await beginRecordingDelivery(meeting);
  // Provider sends were acknowledged before the existing checkpoint API admits terminal persistence.
  const summaryId = await http.send();
  await acknowledgeRecordingDeliveryMessage(meeting, "summary", summaryId);
  const notesId = await http.send();
  await acknowledgeRecordingDeliveryMessage(meeting, "notes", notesId);
  finishRecordingDeliveryMutations(meeting);
  const terminal: MeetingHistory = {
    ...row,
    checkpoint: undefined,
    status: "complete",
    summaryMessageId: summaryId,
    notesChannelId: "910002",
    notesMessageIds: [notesId],
    delivery: {
      summary: { outcome: "complete", intended: 1, sent: 1, errors: [] },
      notes: { outcome: "complete", intended: 1, sent: 1, errors: [] },
    },
  };
  return { meeting, terminal, original };
}
async function correction() {
  return updateMeeting({
    key,
    actor: { editedBy: "synthetic-editor" },
    mutation: {
      kind: "correction",
      changes: [
        { kind: "notes", notes: "Newer edited notes", notesDelta: null },
        { kind: "rename", meetingName: "Newer manual name" },
        { kind: "summarySentence", value: "Newer summary" },
        { kind: "summaryLabel", value: "Newer label" },
      ],
    },
    notesEdit: {
      expectedNotesVersion: 1,
      source: { type: "notes_correction", correctionId: "synthetic-approved" },
    },
  });
}
test.each(["edit-first", "terminal-first"] as const)(
  "initial final-send terminal race preserves canonical content: %s",
  async (order) => {
    const { meeting, terminal } = await initialPublication();
    if (order === "edit-first") expect((await correction()).kind).toBe("saved");
    await saveOwnedMeetingHistoryService(meeting, terminal);
    if (order === "terminal-first")
      expect((await correction()).kind).toBe("saved");
    expect(http.writes.map(({ method }) => method)).toEqual(["POST", "POST"]);
    const before = await mockFixture.read();
    expect(before).toMatchObject({
      status: "complete",
      notes: "Newer edited notes",
      notesVersion: 2,
      contentRevision: 1,
      meetingName: "Newer manual name",
      summarySentence: "Newer summary",
      summaryLabel: "Newer label",
      notesLastEditedBy: "synthetic-editor",
    });
    expect(before?.notesHistory).toHaveLength(1);
    expect(before?.notesHistory?.[0].source).toEqual({
      type: "notes_correction",
      correctionId: "synthetic-approved",
    });
    expect(projectMeetingUpdateDelivery(before!)).toMatchObject({
      status: "held",
      reason: "initial_publication_unsettled",
      pollable: false,
    });
    expect(before?.updateDeliveryDueAt).toBeUndefined();
    await acknowledgeRecordingDeliveryHistory(meeting);
    const after = await mockFixture.read();
    expect(after?.recovery?.disposition).toBe("done");
    expect(after?.updateDelivery?.policy.kind).toBe("active");
    expect(after?.updateDeliveryDueAt).toEqual(expect.any(Number));
    expect(after?.notes).toBe("Newer edited notes");
    expect(after?.updateDelivery?.parts.notesBody.desired).toBe(1);
  },
);
test("original owner replacement fences old terminal and settlement while preserving newer intent", async () => {
  const { meeting, terminal } = await initialPublication();
  await correction();
  const edited = await mockFixture.read();
  if (!edited) throw new Error("Expected existing canonical row");
  await mockFixture.put(mockFixture.tables.meetingHistory, {
    ...edited,
    ownerInstanceId: "replacement",
    executionVersion: 2,
  });
  await expect(
    saveOwnedMeetingHistoryService(meeting, terminal),
  ).rejects.toThrow();
  await expect(acknowledgeRecordingDeliveryHistory(meeting)).rejects.toThrow();
  const after = await mockFixture.read();
  expect(after).toMatchObject({
    ownerInstanceId: "replacement",
    executionVersion: 2,
    notes: "Newer edited notes",
    contentRevision: 1,
  });
  expect(after?.updateDelivery?.policy).toEqual({
    kind: "held",
    reason: "initial_publication_unsettled",
  });
});
test("missing original history cannot create a skeletal publication row", async () => {
  const meeting = {
    guildId: key.guildId,
    meetingId: "synthetic-meeting",
    reservation: reservation(),
    textChannel: { id: "910002" },
  } as unknown as MeetingData;
  await expect(beginRecordingDelivery(meeting)).rejects.toThrow();
  expect(await mockFixture.read()).toBeUndefined();
  expect(http.writes).toEqual([]);
});

test("canonical action winning after terminal read fences stale save then exact reread preserves it", async () => {
  const { meeting, terminal } = await initialPublication();
  const read = mockFixture.original.getMeetingHistory.bind(
    mockFixture.original,
  );
  jest
    .spyOn(mockFixture.original, "getMeetingHistory")
    .mockImplementationOnce(async (...args) => {
      const row = await read(...args);
      await correction();
      return row;
    });
  await expect(
    saveOwnedMeetingHistoryService(meeting, terminal),
  ).rejects.toThrow("fenced");
  expect(await mockFixture.read()).toMatchObject({
    status: "processing",
    notes: "Newer edited notes",
    notesVersion: 2,
    contentRevision: 1,
  });
  await expect(acknowledgeRecordingDeliveryHistory(meeting)).rejects.toThrow(
    "terminal history",
  );
  await saveOwnedMeetingHistoryService(meeting, terminal);
  await acknowledgeRecordingDeliveryHistory(meeting);
  expect(await mockFixture.read()).toMatchObject({
    status: "complete",
    notes: "Newer edited notes",
    notesVersion: 2,
    contentRevision: 1,
    recovery: { disposition: "done" },
  });
});

test.each([
  "rename",
  "notes",
  "warning",
  "rename_then_notes",
  "notes_then_rename",
] as const)(
  "recording terminal merges untouched generated fields after isolated %s edit",
  async (sequence) => {
    const { meeting, terminal } = await initialPublication(true);
    terminal.notes = "Generated original notes";
    terminal.notesVersion = 1;
    terminal.notesLastEditedBy = "synthetic-generator";
    terminal.notesLastEditedAt = "2026-01-02T03:04:05.000Z";
    terminal.notesHistory = [
      {
        version: 1,
        notes: terminal.notes,
        editedBy: terminal.notesLastEditedBy,
        editedAt: terminal.notesLastEditedAt,
      },
    ];
    for (const kind of sequence.split("_then_")) {
      const mutation: Parameters<typeof updateMeeting>[0]["mutation"] =
        kind === "rename"
          ? { kind: "rename", meetingName: "Manual rename" }
          : kind === "notes"
            ? { kind: "notes", notes: "Manual notes", notesDelta: null }
            : { kind: "warning", target: "both" };
      const saved = await updateMeeting({
        key,
        mutation,
        actor: { editedBy: "synthetic-editor" },
        notesEdit:
          kind === "notes"
            ? { expectedNotesVersion: 1, source: { type: "web_editor" } }
            : undefined,
      });
      expect(saved.kind).toBe("saved");
    }
    await saveOwnedMeetingHistoryService(meeting, terminal);
    const row = await mockFixture.read();
    assertRecordingCanonicalMerge(row, terminal, sequence);
    expect(projectMeetingUpdateDelivery(row!)).toMatchObject({
      status: "held",
      reason: "initial_publication_unsettled",
    });
    await acknowledgeRecordingDeliveryHistory(meeting);
    expect((await mockFixture.read())?.updateDelivery?.policy.kind).toBe(
      "active",
    );
  },
);

test("unknown newer canonical metadata fences recording terminal completion", async () => {
  const { meeting, terminal } = await initialPublication(true);
  const row = await mockFixture.read();
  if (!row) throw new Error("Expected original row");
  await mockFixture.put(mockFixture.tables.meetingHistory, {
    ...row,
    contentRevision: 1,
    contentMutation: { id: "legacy-edit", fingerprint: "a".repeat(64) },
  });
  await expect(
    saveOwnedMeetingHistoryService(meeting, terminal),
  ).rejects.toThrow("canonical baseline is stale");
  expect((await mockFixture.read())?.status).toBe("processing");
  await expect(acknowledgeRecordingDeliveryHistory(meeting)).rejects.toThrow(
    "terminal history",
  );
});

function assertRecordingCanonicalMerge(
  row: MeetingHistory | undefined,
  terminal: MeetingHistory,
  sequence: string,
) {
  expect(row).toMatchObject({
    status: "complete",
    contentRevision: sequence.split("_then_").length,
    notes: sequence.includes("notes") ? "Manual notes" : terminal.notes,
    notesVersion: sequence.includes("notes") ? 2 : 1,
    meetingName: sequence.includes("rename")
      ? "Manual rename"
      : terminal.meetingName,
    summarySentence: terminal.summarySentence,
    summaryLabel: terminal.summaryLabel,
  });
  if (sequence === "warning")
    expect(row?.updateDelivery?.parts).toMatchObject({
      notesWarning: { desired: 1, acknowledged: 0 },
      summaryWarning: { desired: 1, acknowledged: 0 },
      notesBody: { desired: 0, acknowledged: 0 },
    });
  if (sequence.includes("notes")) {
    expect(row?.notesHistory).toEqual([
      expect.objectContaining({
        version: 2,
        notes: "Manual notes",
        editedBy: "synthetic-editor",
        source: { type: "web_editor" },
      }),
    ]);
    expect(row?.notesLastEditedBy).toBe("synthetic-editor");
  } else {
    expect(row?.notesHistory).toEqual(terminal.notesHistory);
    expect(row?.notesLastEditedBy).toBe("synthetic-generator");
  }
}
