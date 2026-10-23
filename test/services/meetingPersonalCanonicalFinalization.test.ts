/** @jest-environment node */
jest.mock("../../src/services/notionAutomationService", () => ({
  maybeAutoSyncMeetingNotes: jest.fn(async () => {}),
}));
jest.mock("../../src/services/meetingUpdateDeliveryWorkerService", () => ({
  verifyMeetingUpdateDeliveryReadiness: jest.fn(async () => {}),
}));
import { getMockStore, resetMockStore } from "../../src/repositories/mockStore";
import { getPersonalMediaUploadRepository } from "../../src/repositories/personalMediaUploadRepository";
import { createMockMeetingUpdateDeliveryRepository } from "../../src/repositories/mockMeetingUpdateDeliveryRepository";
import { createMeetingUpdateService } from "../../src/services/meetingUpdateService";
import type {
  MeetingHistory,
  PersonalMediaUploadJobRecord,
  PersonalMediaClaim,
} from "../../src/types/db";
import type { MeetingUpdateMutation } from "../../src/types/meetingUpdateDelivery";
import { history } from "../types/meetingUpdateDelivery.fixture";

beforeEach(() => resetMockStore());

test.each([
  "rename",
  "notes",
  "warning",
  "rename_then_notes",
  "notes_then_rename",
  "untracked",
] as const)(
  "personal terminal merges untouched generation after isolated edits: %s",
  async (sequence) => {
    const row: MeetingHistory = {
      ...history(),
      guildId: "personal:synthetic-owner",
      ownerUserId: "synthetic-owner",
      ownershipScope: "personal",
      status: "processing",
    };
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
      Reflect.deleteProperty(row, field);
    const generated: MeetingHistory = {
      ...row,
      status: "complete",
      notes: "Generated original notes",
      notesVersion: 1,
      notesLastEditedBy: "synthetic-owner",
      notesLastEditedAt: "2026-01-02T03:04:05.000Z",
      notesHistory: [
        {
          version: 1,
          notes: "Generated original notes",
          editedBy: "synthetic-owner",
          editedAt: "2026-01-02T03:04:05.000Z",
        },
      ],
      meetingName: "Generated name",
      summarySentence: "Generated summary",
      summaryLabel: "Generated label",
    };
    const claim: PersonalMediaClaim = {
      uploadId: "synthetic-upload",
      instanceId: "synthetic-worker",
      attempt: 1,
      claimId: "synthetic-claim",
      nowEpochSeconds: Math.floor(Date.now() / 1000),
    };
    const job: PersonalMediaUploadJobRecord = {
      uploadId: claim.uploadId,
      ownerUserId: row.ownerUserId!,
      status: "processing",
      attempts: claim.attempt,
      processingClaimId: claim.claimId,
      processingOwnerInstanceId: claim.instanceId,
      claimExpiresAt: claim.nowEpochSeconds + 3600,
      mediaKind: "audio",
      sourceS3Key: "synthetic/source.mp3",
      contentType: "audio/mpeg",
      fileSize: 1,
      createdAt: row.timestamp,
      updatedAt: row.timestamp,
    };
    const store = getMockStore();
    store.meetingHistoryByGuild.set(row.guildId, [row]);
    store.personalMediaUploadsById.set(job.uploadId, job);
    const key = {
      guildId: row.guildId,
      channelId_timestamp: row.channelId_timestamp,
    };
    const action = createMeetingUpdateService({
      repository: createMockMeetingUpdateDeliveryRepository(
        store.meetingHistoryByGuild,
        () => true,
      ),
      ready: async () => {},
      syncNotes: jest.fn(async () => {}),
    });
    if (sequence === "untracked") {
      row.contentRevision = 1;
      row.contentMutation = { id: "legacy-edit", fingerprint: "a".repeat(64) };
    }
    for (const step of sequence === "untracked"
      ? []
      : sequence.split("_then_")) {
      const mutation: MeetingUpdateMutation =
        step === "rename"
          ? { kind: "rename", meetingName: "Manual rename" }
          : step === "notes"
            ? { kind: "notes", notes: "Manual notes", notesDelta: null }
            : { kind: "warning", target: "both" };
      expect(
        (
          await action({
            key,
            mutation,
            actor: { editedBy: "synthetic-editor" },
            notesEdit:
              step === "notes"
                ? { expectedNotesVersion: 1, source: { type: "web_editor" } }
                : undefined,
          })
        ).kind,
      ).toBe("saved");
    }
    const written = await getPersonalMediaUploadRepository().writeHistory(
      generated,
      claim,
      {
        ...job,
        status: "complete",
      },
    );
    const saved = store.meetingHistoryByGuild.get(row.guildId)?.[0];
    if (sequence === "untracked") {
      expect(written).toEqual({ kind: "stale" });
      expect(saved?.status).toBe("processing");
      expect(store.personalMediaUploadsById.get(job.uploadId)?.status).toBe(
        "processing",
      );
      return;
    }
    expect(written.kind).toBe("committed");
    expect(store.personalMediaUploadsById.get(job.uploadId)?.status).toBe(
      "complete",
    );
    assertPersonalCanonicalMerge(saved, generated, sequence);
  },
);

function assertPersonalCanonicalMerge(
  saved: MeetingHistory | undefined,
  generated: MeetingHistory,
  sequence: string,
) {
  expect(saved).toMatchObject({
    status: "complete",
    contentRevision: sequence.split("_then_").length,
    notes: sequence.includes("notes") ? "Manual notes" : generated.notes,
    notesVersion: sequence.includes("notes") ? 2 : 1,
    meetingName: sequence.includes("rename")
      ? "Manual rename"
      : generated.meetingName,
    summarySentence: generated.summarySentence,
    summaryLabel: generated.summaryLabel,
    updateDelivery: { policy: { kind: "unpublished" } },
  });
  if (sequence === "warning")
    expect(saved?.updateDelivery?.parts).toMatchObject({
      notesWarning: { desired: 1, acknowledged: 0 },
      summaryWarning: { desired: 1, acknowledged: 0 },
      notesBody: { desired: 0, acknowledged: 0 },
    });
  if (sequence.includes("notes")) {
    expect(saved?.notesHistory).toEqual([
      expect.objectContaining({
        version: 2,
        notes: "Manual notes",
        editedBy: "synthetic-editor",
        source: { type: "web_editor" },
      }),
    ]);
  } else expect(saved?.notesHistory).toEqual(generated.notesHistory);
}
