/** @jest-environment node */

import { publicationDynamoFixture } from "./meetingPublicationDynamo.fixture";
import { createMeetingUpdateService } from "../../src/services/meetingUpdateService";
import { writeRecoveredArtifactHistory } from "../../scripts/recoveredMeetingArtifactWrite";
import {
  history,
  key,
  pointers,
  pending,
  attempt,
} from "../types/meetingUpdateDelivery.fixture";
let f: Awaited<ReturnType<typeof publicationDynamoFixture>>;
beforeAll(async () => {
  f = await publicationDynamoFixture();
});
afterAll(async () => {
  await f.close();
});
test("artifact repair preserves canonical notes, durable intent and a worker transition committed after its snapshot", async () => {
  const before = {
    ...history(),
    ...pointers,
    contentRevision: 1,
    notesVersion: 1,
    updateDelivery: pending(),
    transcriptS3Key: "synthetic/old-transcript.json",
    status: "complete" as const,
  };
  await f.put(f.tables.meetingHistory, before);
  const update = createMeetingUpdateService({
    repository: f.updates,
    ready: async () => {},
    syncNotes: async () => {},
  });
  const saved = await update({
    key,
    mutation: { kind: "notes", notes: "New canonical synthetic notes" },
    actor: { editedBy: "synthetic" },
    notesEdit: { expectedNotesVersion: 1, source: { type: "web_editor" } },
  });
  expect(saved.kind).toBe("saved");
  const changed = await f.read();
  if (!changed?.updateDelivery) throw new Error("Expected committed intent");
  const authority = await f.admit();
  expect(
    await f.updates.claim({
      key,
      expectedContentRevision: 2,
      expectedDeliveryRevision: changed.updateDelivery.revision,
      attempt: {
        ...attempt(),
        contentRevision: 2,
        capturedParts: { notesBody: 2 },
      },
      authority,
    }),
  ).toBe("claimed");
  const claimed = await f.read();
  await writeRecoveredArtifactHistory({
    client: f.client,
    table: f.tables.meetingHistory,
    before,
    fields: {
      transcriptS3Key: "synthetic/repaired-transcript.json",
      duration: 120,
    },
  });
  expect(await f.read()).toMatchObject({
    notes: "New canonical synthetic notes",
    notesVersion: 2,
    contentRevision: 2,
    transcriptS3Key: "synthetic/repaired-transcript.json",
    duration: 120,
    updateDelivery: claimed?.updateDelivery,
  });
});
