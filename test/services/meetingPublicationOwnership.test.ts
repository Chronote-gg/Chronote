/** @jest-environment node */
jest.mock("../../src/services/notionAutomationService", () => ({
  maybeAutoSyncMeetingNotes: jest.fn(async () => {}),
}));
jest.mock("../../src/services/meetingUpdateDeliveryWorkerService", () => ({
  verifyMeetingUpdateDeliveryReadiness: jest.fn(async () => {}),
}));
import { updateMeetingNotesService } from "../../src/services/meetingHistoryService";
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
import { claimOwner } from "../repositories/meetingUpdateDeliveryContract";
beforeEach(() => resetMockStore());
afterEach(() => jest.restoreAllMocks());
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
  const repository = createMockMeetingUpdateDeliveryRepository(histories);
  expect(
    await repository.claim({
      key,
      expectedContentRevision: 1,
      expectedDeliveryRevision: row.updateDelivery.revision,
      attempt: attempt(),
      ...claimOwner,
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

test("canonical edits begun after publication acquisition are rejected without changing notes", async () => {
  const row = {
    ...history(),
    status: "interrupted" as const,
    notesVersion: 1,
    publicationRepair: {
      kind: "running" as const,
      purpose: "first_publication" as const,
      runId: "first-publication",
      previewDigest: "a".repeat(64),
      receiptKey: "authority",
      snapshot: "b".repeat(64),
    },
  };
  getMockStore().meetingHistoryByGuild.set(key.guildId, [row]);
  const before = JSON.stringify(row);
  expect(
    await updateMeetingNotesService({
      ...key,
      notes: "Racing edit",
      notesVersion: 2,
      editedBy: "synthetic",
      expectedPreviousVersion: 1,
    }),
  ).toBe(false);
  expect(
    JSON.stringify(getMockStore().meetingHistoryByGuild.get(key.guildId)?.[0]),
  ).toBe(before);
});
