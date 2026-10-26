/** @jest-environment node */
jest.mock("../../src/services/notionAutomationService", () => ({
  maybeAutoSyncMeetingNotes: jest.fn(async () => {}),
}));
jest.mock("../../src/services/meetingUpdateDeliveryWorkerService", () => ({
  verifyMeetingUpdateDeliveryReadiness: jest.fn(async () => {}),
}));
import {
  updateMeetingNotesService,
  updateMeetingNameService,
} from "../../src/services/meetingHistoryService";
import { getMeetingUpdateDeliveryRepository } from "../../src/db";
import { getMockStore, resetMockStore } from "../../src/repositories/mockStore";
import { maybeAutoSyncMeetingNotes } from "../../src/services/notionAutomationService";
import {
  history,
  key,
  pending,
  pointers,
} from "../types/meetingUpdateDelivery.fixture";

beforeEach(() => {
  resetMockStore();
  jest.clearAllMocks();
});
function fixture() {
  const row = {
    ...history(),
    ...pointers,
    notesVersion: 1,
    contentRevision: 1,
    updateDelivery: pending(),
    notesDelta: { ops: [{ insert: "Old" }] },
  };
  getMockStore().meetingHistoryByGuild.set(key.guildId, [row]);
  return row;
}
const edit = () =>
  updateMeetingNotesService({
    ...key,
    notes: "Edited synthetic notes",
    notesDelta: null,
    notesVersion: 2,
    editedBy: "synthetic-editor",
    expectedPreviousVersion: 1,
    source: {
      type: "manual_import",
      importMode: "replace",
      sourceName: "Synthetic file",
    },
  });
test("acknowledged notes save retains canonical audit and durable requested body without invoking Discord", async () => {
  fixture();
  expect(await edit()).toBe(true);
  const row = await getMeetingUpdateDeliveryRepository().getStrong(key);
  expect(row).toMatchObject({
    notes: "Edited synthetic notes",
    notesVersion: 2,
    contentRevision: 2,
    updateDelivery: {
      parts: { notesBody: { desired: 2, acknowledged: 0 } },
      progress: { kind: "pending" },
    },
  });
  expect(row?.notesDelta).toBeUndefined();
  expect(row?.notesHistory?.at(-1)).toMatchObject({
    version: 2,
    editedBy: "synthetic-editor",
    source: { type: "manual_import", importMode: "replace" },
  });
  expect(maybeAutoSyncMeetingNotes).toHaveBeenCalledTimes(1);
  expect(
    jest.mocked(maybeAutoSyncMeetingNotes).mock.calls[0][0].contentRevision,
  ).toBe(2);
});
test("notes conflict preserves canonical content and intent and invokes no Notion hook", async () => {
  const row = fixture();
  row.notesVersion = 3;
  const before = structuredClone(row);
  expect(await edit()).toBe(false);
  expect(await getMeetingUpdateDeliveryRepository().getStrong(key)).toEqual(
    before,
  );
  expect(maybeAutoSyncMeetingNotes).not.toHaveBeenCalled();
});
test("rename retains pending notes body and requests both titles without a notes version increment", async () => {
  fixture();
  expect(
    await updateMeetingNameService({
      ...key,
      meetingName: "Synthetic renamed meeting",
    }),
  ).toBe(true);
  expect(
    await getMeetingUpdateDeliveryRepository().getStrong(key),
  ).toMatchObject({
    meetingName: "Synthetic renamed meeting",
    notesVersion: 1,
    contentRevision: 2,
    updateDelivery: {
      parts: {
        notesBody: { desired: 1, acknowledged: 0 },
        notesTitle: { desired: 2, acknowledged: 0 },
        summaryTitle: { desired: 2, acknowledged: 0 },
      },
    },
  });
  expect(maybeAutoSyncMeetingNotes).not.toHaveBeenCalled();
});
test("ordinary notes save retains an explicit stored-only publication hold", async () => {
  const row = fixture();
  row.updateDelivery.policy = { kind: "held", reason: "stored_only" };
  expect(await edit()).toBe(true);
  expect(
    await getMeetingUpdateDeliveryRepository().getStrong(key),
  ).toMatchObject({
    contentRevision: 2,
    updateDelivery: { policy: { kind: "held", reason: "stored_only" } },
  });
});
