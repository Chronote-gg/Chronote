/** @jest-environment node */
import { DiscordAPIError } from "discord.js";
import { updateMeetingSummaryMessage } from "../../src/embed";
import { saveMeetingHistoryToDatabase } from "../../src/commands/saveMeetingHistory";
import { initialMeetingUpdatePolicy } from "../../src/types/meetingPublication";
import { discordEditorMessageSchema } from "../../src/services/discordMessageEditor";
import "../services/recordingPublicationRuntime";
jest.mock("../../src/services/summaryUpgradeService", () => ({
  claimSummaryUpgrade: async () => ({
    url: "https://example.invalid/upgrade",
    recordedSeconds: 5400,
  }),
}));
jest.mock("../../src/services/liveMeetingNotesService", () => ({
  ensureLiveMeetingNotes: async (meeting: MeetingData) => meeting.notesText,
  ensureLiveMeetingSummaries: async (meeting: MeetingData) => ({
    summarySentence: meeting.summarySentence,
    summaryLabel: meeting.summaryLabel,
  }),
}));
import { featureCanonicalRecords } from "../services/meetingCanonicalPeers.fixture";
import { publicationHttpFixture } from "./meetingPublicationHttp.fixture";
import type { MeetingData } from "../../src/types/meeting-data";
import type { MeetingHistory } from "../../src/types/db";
import { publicationDynamoFixture } from "./meetingPublicationDynamo.fixture";
import { key, history } from "../types/meetingUpdateDelivery.fixture";
import {
  beginRecordingDelivery,
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
  maybeAutoExportCompletedMeeting: async () => undefined,
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
async function initialPublication(
  initiallyEmpty = false,
  mode: "existing" | "no-start" | "missing-start" = "no-start",
  beforeDelivery?: (meeting: MeetingData) => Promise<void>,
) {
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
  const startId = mode === "no-start" ? undefined : "910003";
  if (mode === "existing")
    http.remote.set(
      "910003",
      discordEditorMessageSchema.parse({
        id: "910003",
        channel_id: "910002",
        author: { id: "910001", bot: true },
        content: "",
        embeds: [],
        components: [],
        attachments: [],
        flags: 0,
      }),
    );
  const meeting = {
    guildId: row.guildId,
    guild: { id: row.guildId, name: "Synthetic" },
    meetingId: row.meetingId,
    reservation: original,
    sessionMode: "meeting",
    creator: { id: "synthetic-generator" },
    voiceChannel: { id: row.channelId, name: "Synthetic" },
    textChannel: {
      id: "910002",
      send: (payload: unknown) => http.write(payload),
      messages: {
        fetch: async (id: string) => {
          const response = await http.fetchImpl(
            "https://discord.test/api/v10/channels/910002/messages/" + id,
          );
          if (response.status === 404)
            throw new DiscordAPIError(
              { code: 10008, message: "Unknown Message" },
              10008,
              404,
              "GET",
              "https://discord.test/messages/" + id,
              { body: undefined, files: [] },
            );
          const message = discordEditorMessageSchema.parse(
            await response.json(),
          );
          return {
            ...message,
            edit: (payload: unknown) => http.write(payload, id),
          };
        },
      },
    },
    startMessageId: startId,
    startTime: new Date(row.timestamp),
    endTime: new Date(Date.parse(row.timestamp) + 60000),
    attendance: new Set(),
    participants: new Map(),
    audioData: { audioFiles: [] },
    generateNotes: true,
    transcribeMeeting: true,
    notesText: row.notes,
    notesVersion: 1,
    meetingName: row.meetingName,
    summarySentence: row.summarySentence,
    summaryLabel: row.summaryLabel,
    processing: {
      transcription: "ready",
      notes: "generated",
      summary: "generated",
    },
  } as unknown as MeetingData;
  await beforeDelivery?.(meeting);
  await updateMeetingSummaryMessage(meeting, { finalization: true });
  const terminal: MeetingHistory = {
    ...row,
    checkpoint: undefined,
    status: "complete",
    summaryMessageId: meeting.summaryMessageId,
    notesChannelId: "910002",
    notesMessageIds: meeting.notesMessageIds,
    delivery: meeting.delivery,
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

test("canonical action winning after terminal read completes through one owned save", async () => {
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
  const saved = await saveOwnedMeetingHistoryService(meeting, terminal);
  expect(saved).toMatchObject({
    status: "complete",
    notes: "Newer edited notes",
    notesVersion: 2,
    meetingName: "Newer manual name",
    summarySentence: "Newer summary",
    summaryLabel: "Newer label",
    notesLastEditedBy: "synthetic-editor",
  });
  expect(saved.notesHistory).toHaveLength(1);
  expect(saved.notesHistory?.[0].source).toEqual({
    type: "notes_correction",
    correctionId: "synthetic-approved",
  });
  const before = await mockFixture.read();
  expect(projectMeetingUpdateDelivery(before!)).toMatchObject({
    status: "held",
    reason: "initial_publication_unsettled",
    pollable: false,
  });
  expect(before?.updateDeliveryDueAt).toBeUndefined();
  await acknowledgeRecordingDeliveryHistory(meeting);
  expect(await mockFixture.read()).toMatchObject({
    status: "complete",
    notes: "Newer edited notes",
    notesVersion: 2,
    contentRevision: 1,
    recovery: { disposition: "done" },
  });
  const after = await mockFixture.read();
  expect(after?.updateDelivery?.policy.kind).toBe("active");
  expect(after?.updateDeliveryDueAt).toEqual(expect.any(Number));
  expect(after?.updateDelivery?.parts.notesBody.desired).toBe(1);
  expect(http.writes.map(({ method }) => method)).toEqual(["POST", "POST"]);
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

test.each(["existing", "no-start", "missing-start"] as const)(
  "actual %s producer metadata persists and activates through terminal ACK",
  async (mode) => {
    const { meeting } = await initialPublication(false, mode);
    await correction();
    await saveMeetingHistoryToDatabase(meeting);
    expect(meeting.historySaved).toBe(true);
    await acknowledgeRecordingDeliveryHistory(meeting);
    const row = await mockFixture.read();
    expect(row?.updateDelivery?.policy.kind).toBe("active");
    expect(row?.delivery?.summary).toMatchObject({
      outcome: mode === "existing" ? "edited_existing" : "sent_fallback",
      errors: [],
    });
    if (mode === "missing-start")
      expect(row?.delivery?.summary).toHaveProperty("recoveredMissingMessage", {
        code: 10008,
        status: 404,
      });
    expect(http.writes.map((write) => write.method)).toEqual(
      mode === "existing" ? ["PATCH", "POST"] : ["POST", "POST"],
    );
    const notes = http.remote.get(row!.notesMessageIds![0])!;
    expect(notes.components.length).toBeGreaterThan(0);
    expect(notes.embeds.at(-1)).toHaveProperty("fields", [
      expect.objectContaining({ name: "Need more recording time?" }),
    ]);
    expect(
      initialMeetingUpdatePolicy({ ...row!, updateDelivery: undefined }),
    ).toEqual({ kind: "active" });
  },
);
test.each([1, 2, 3])(
  "real Dynamo canonical metadata conflict budget %i keeps one provider invocation",
  async (conflicts) => {
    let attempts = 0;
    const transition = mockFixture.original.transitionMeetingHistory.bind(
      mockFixture.original,
    );
    const statuses: string[] = [];
    const work = initialPublication(false, "existing", async () => {
      jest
        .spyOn(mockFixture.original, "transitionMeetingHistory")
        .mockImplementation(async (input) => {
          if (input.recordingDelivery && input.patch.summaryMessageId) {
            attempts++;
            if (attempts <= conflicts)
              expect(
                (
                  await updateMeeting({
                    key,
                    actor: { editedBy: "editor" },
                    mutation: {
                      kind: "rename",
                      meetingName: "Edited " + attempts,
                    },
                  })
                ).kind,
              ).toBe("saved");
          }
          const result = await transition(input);
          if (input.patch.summaryMessageId) statuses.push(result);
          return result;
        });
    });
    if (conflicts === 3) {
      await expect(work).rejects.toThrow("fenced");
      expect(http.writes.map((write) => write.method)).toEqual(["PATCH"]);
      expect(statuses).toEqual(["stale", "stale", "stale"]);
    } else {
      const { meeting, terminal } = await work;
      expect(statuses).toEqual([...Array(conflicts).fill("stale"), "applied"]);
      await saveOwnedMeetingHistoryService(meeting, terminal);
      await acknowledgeRecordingDeliveryHistory(meeting);
      expect((await mockFixture.read())?.updateDelivery?.policy.kind).toBe(
        "active",
      );
      expect(http.writes.map((write) => write.method)).toEqual([
        "PATCH",
        "POST",
      ]);
    }
    expect(attempts).toBe(Math.min(3, conflicts + 1));
  },
);
test.each(["intent", "notes", "terminal"] as const)(
  "real canonical race retries %s metadata in place",
  async (phase) => {
    let raced = false;
    const transition = mockFixture.original.transitionMeetingHistory.bind(
      mockFixture.original,
    );
    const statuses: string[] = [];
    const { meeting, terminal } = await initialPublication(
      false,
      "no-start",
      async () => {
        jest
          .spyOn(mockFixture.original, "transitionMeetingHistory")
          .mockImplementation(async (input) => {
            const target =
              Boolean(input.recordingDelivery) &&
              (phase === "intent"
                ? input.recordingDelivery?.phase === "intent"
                : phase === "notes"
                  ? Boolean(input.patch.notesMessageIds)
                  : input.patch.recovery?.disposition === "done");
            if (target && !raced) {
              raced = true;
              expect(
                (
                  await updateMeeting({
                    key,
                    actor: { editedBy: "editor" },
                    mutation: { kind: "rename", meetingName: "Raced" },
                  })
                ).kind,
              ).toBe("saved");
            }
            const result = await transition(input);
            if (target) statuses.push(result);
            return result;
          });
      },
    );
    await saveOwnedMeetingHistoryService(meeting, terminal);
    await acknowledgeRecordingDeliveryHistory(meeting);
    expect(statuses).toEqual(["stale", "applied"]);
    expect((await mockFixture.read())?.updateDelivery?.policy.kind).toBe(
      "active",
    );
    expect(http.writes.map((write) => write.method)).toEqual(["POST", "POST"]);
  },
);
test.each([false, true])(
  "real expired lease fences summary metadata even with canonical change=%s",
  async (canonical) => {
    let expired = false;
    const transition = mockFixture.original.transitionMeetingHistory.bind(
      mockFixture.original,
    );
    const statuses: string[] = [];
    await expect(
      initialPublication(false, "existing", async () => {
        jest
          .spyOn(mockFixture.original, "transitionMeetingHistory")
          .mockImplementation(async (input) => {
            if (
              input.recordingDelivery &&
              input.patch.summaryMessageId &&
              !expired
            ) {
              expired = true;
              if (canonical)
                await updateMeeting({
                  key,
                  actor: { editedBy: "editor" },
                  mutation: { kind: "rename", meetingName: "New" },
                });
              await mockFixture.put(mockFixture.tables.activeMeeting, {
                ...reservation(),
                leaseExpiresAt: Math.floor(Date.now() / 1000) - 1,
              });
            }
            const result = await transition(input);
            if (input.patch.summaryMessageId) statuses.push(result);
            return result;
          });
      }),
    ).rejects.toThrow("fenced");
    expect(statuses).toEqual(canonical ? ["stale", "stale"] : ["stale"]);
    expect(http.writes.map((write) => write.method)).toEqual(["PATCH"]);
    expect((await mockFixture.read())?.summaryMessageId).toBeUndefined();
  },
);

test.each(["fetch", "fallback", "ack"] as const)(
  "actual producer %s failure cannot activate the original publication",
  async (boundary) => {
    await expect(
      initialPublication(
        false,
        boundary === "fetch" ? "existing" : "missing-start",
        async (meeting) => {
          await correction();
          if (boundary === "fetch")
            jest
              .spyOn(meeting.textChannel.messages, "fetch")
              .mockRejectedValueOnce(new Error("Ambiguous fetch"));
          if (boundary === "fallback") http.rejectNextMutation("POST", 500);
          if (boundary === "ack") {
            const transition =
              mockFixture.original.transitionMeetingHistory.bind(
                mockFixture.original,
              );
            jest
              .spyOn(mockFixture.original, "transitionMeetingHistory")
              .mockImplementation(async (input) => {
                if (input.recordingDelivery && input.patch.summaryMessageId)
                  throw new Error("Uncommitted summary ACK");
                return transition(input);
              });
          }
        },
      ),
    ).rejects.toThrow();
    const row = await mockFixture.read();
    expect(row?.recovery?.disposition).toBe("needs_reconciliation");
    expect(row?.updateDelivery?.policy).toEqual({
      kind: "held",
      reason: "initial_publication_unsettled",
    });
    expect(row?.updateDeliveryDueAt).toBeUndefined();
    expect(http.writes.map((write) => write.method)).toEqual(
      boundary === "fetch" ? [] : ["POST"],
    );
  },
);
