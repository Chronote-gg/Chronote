/** @jest-environment node */
jest.mock("../../src/services/notionAutomationService", () => ({
  maybeAutoSyncMeetingNotes: jest.fn(async () => {}),
}));
jest.mock("../../src/services/meetingUpdateDeliveryWorkerService", () => ({
  verifyMeetingUpdateDeliveryReadiness: jest.fn(async () => {}),
}));
import { reserveFeaturePublication } from "./meetingPublicationRuntime.fixture";
import type { MeetingData } from "../../src/types/meeting-data";
import {
  saveOwnedMeetingHistoryService,
  updateMeetingNotesService,
} from "../../src/services/meetingHistoryService";
import { getMockStore, resetMockStore } from "../../src/repositories/mockStore";
import { createMockMeetingUpdateDeliveryRepository } from "../../src/repositories/mockMeetingUpdateDeliveryRepository";
import {
  history,
  key,
  pointers,
  pending,
  attempt,
} from "../types/meetingUpdateDelivery.fixture";
import { publicationSnapshotDigest } from "../../src/types/meetingPublication";
import { parseMeetingUpdateHistory } from "../../src/repositories/meetingUpdateDeliveryState";
import { personalProcessingHistoryFields } from "../../src/db";
import { authority } from "../repositories/meetingUpdateDeliveryContract";
beforeEach(() => resetMockStore());
test("initial terminal persistence after a newer notes save preserves the canonical edit and its intent", async () => {
  const row = {
    ...history(),
    ...pointers,
    status: "processing" as const,
    ownerInstanceId: "original-owner",
    executionVersion: 1,
  };
  const owned = await reserveFeaturePublication(row);
  try {
    const generated = {
      ...owned.row,
      status: "complete" as const,
      notes: "Original generated notes",
      notesVersion: 1,
    };
    const meeting = {
      reservation: owned.reservation,
    } as unknown as MeetingData;
    expect(
      await updateMeetingNotesService({
        ...key,
        notes: "New canonical notes",
        notesVersion: 2,
        editedBy: "synthetic",
        expectedPreviousVersion: 1,
      }),
    ).toBe(true);
    await saveOwnedMeetingHistoryService(meeting, generated);
    const saved = getMockStore().meetingHistoryByGuild.get(key.guildId)?.[0];
    expect(saved).toMatchObject({
      status: "complete",
      notes: "New canonical notes",
      notesVersion: 2,
      contentRevision: 1,
      updateDelivery: {
        policy: { kind: "held", reason: "initial_publication_unsettled" },
        parts: { notesBody: { desired: 1 } },
      },
    });
    expect(saved?.notesHistory?.at(-1)?.notes).toBe("New canonical notes");
  } finally {
    await owned.close();
  }
});
test("an exact retained repair owner excludes an update claim regardless of active update policy", async () => {
  const row = Object.assign(
    {
      ...history(),
      ...pointers,
      contentRevision: 1,
      updateDelivery: pending(),
    },
    {
      publicationRepair: {
        kind: "running",
        runId: "synthetic-run",
        previewDigest: "a".repeat(64),
        receiptKey: "synthetic/receipt.json",
        snapshot: "b".repeat(64),
      },
    },
  );
  const histories = new Map([[key.guildId, [row]]]);
  const repository = createMockMeetingUpdateDeliveryRepository(
    histories,
    () => true,
  );
  expect(
    await repository.claim({
      key,
      expectedContentRevision: 1,
      expectedDeliveryRevision: row.updateDelivery.revision,
      attempt: attempt(),
      authority,
    }),
  ).toBe("stale");
  expect(histories.get(key.guildId)?.[0]).toEqual(row);
});

test("publication snapshot fingerprints ignore nested map property order", () => {
  expect(
    publicationSnapshotDigest({
      ...history(),
      operatorRecovery: { id: "synthetic", state: "known" },
    }),
  ).toBe(
    publicationSnapshotDigest({
      ...history(),
      operatorRecovery: { state: "known", id: "synthetic" },
    }),
  );
});
test("stored malformed repair ownership fails the repository boundary", () => {
  expect(() =>
    parseMeetingUpdateHistory({
      ...history(),
      publicationRepair: { kind: "running" },
    }),
  ).toThrow();
});
test("personal terminal fields omit canonical generation when a newer action already saved it", () => {
  const original = {
    ...history(),
    notesVersion: 1,
    notes: "Original generation",
  };
  const edited = {
    ...original,
    contentRevision: 1,
    notesVersion: 2,
    notes: "New canonical notes",
    contentMutation: {
      id: "tracked-edit",
      fingerprint: "a".repeat(64),
      fieldRevisions: { notes: 1 },
    },
    updateDelivery: pending(),
  };
  const fields = Object.fromEntries(
    personalProcessingHistoryFields(original, edited) ?? [],
  );
  expect(fields).not.toHaveProperty("notes");
  expect(fields).not.toHaveProperty("notesVersion");
  expect(fields).not.toHaveProperty("updateDelivery");
});
