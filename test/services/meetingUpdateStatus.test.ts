/** @jest-environment node */
import { projectMeetingUpdateDelivery } from "../../src/services/meetingUpdateStatus";
import {
  history,
  pending,
  pointers,
  now,
} from "../types/meetingUpdateDelivery.fixture";
test("a retained repair owner reports a non-pollable hold while canonical work remains pending", () => {
  const row = {
    ...history(),
    ...pointers,
    contentRevision: 2,
    updateDelivery: pending(),
    publicationRepair: {
      kind: "running" as const,
      runId: "synthetic",
      previewDigest: "a".repeat(64),
      receiptKey: "synthetic/receipt",
      snapshot: "b".repeat(64),
    },
  };
  expect(projectMeetingUpdateDelivery(row)).toMatchObject({
    status: "held",
    reason: "repair_publication_unsettled",
    pollable: false,
    desiredRevision: 2,
    syncedRevision: null,
  });
});
test("unsettled original publication is held before an envelope exists", () => {
  expect(
    projectMeetingUpdateDelivery({ ...history(), status: "processing" }),
  ).toMatchObject({
    status: "held",
    reason: "initial_publication_unsettled",
    pollable: false,
    syncedRevision: null,
  });
});
test("captured revision seven does not confirm outstanding revision-six title work", () => {
  const delivery = pending();
  delivery.parts.notesBody = { desired: 5, acknowledged: 5 };
  delivery.progress = { kind: "synced", syncedAt: now };
  delivery.lastSuccess = { at: now, contentRevision: 5 };
  expect(
    projectMeetingUpdateDelivery({
      ...history(),
      contentRevision: 5,
      updateDelivery: delivery,
    }).syncedRevision,
  ).toBe(5);
  delivery.parts.notesTitle = { desired: 6, acknowledged: 0 };
  delivery.progress = { kind: "pending", nextCheckAt: now };
  expect(
    projectMeetingUpdateDelivery({
      ...history(),
      contentRevision: 6,
      updateDelivery: delivery,
    }).syncedRevision,
  ).toBeNull();
  delivery.parts.notesBody = { desired: 7, acknowledged: 7 };
  delivery.lastSuccess = { at: now + 1, contentRevision: 7 };
  expect(
    projectMeetingUpdateDelivery({
      ...history(),
      contentRevision: 7,
      updateDelivery: delivery,
    }),
  ).toMatchObject({
    status: "pending",
    syncedRevision: null,
    lastSuccess: { contentRevision: 7 },
  });
});
test("synced progress without agreeing completion evidence is not pollable or up to date", () => {
  const delivery = pending();
  delivery.parts.notesBody = { desired: 1, acknowledged: 1 };
  delivery.progress = { kind: "synced", syncedAt: now };
  expect(
    projectMeetingUpdateDelivery({
      ...history(),
      contentRevision: 1,
      updateDelivery: delivery,
    }),
  ).toMatchObject({ status: "held", pollable: false, syncedRevision: null });
});
