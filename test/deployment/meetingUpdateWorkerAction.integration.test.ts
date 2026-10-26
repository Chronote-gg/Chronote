/** @jest-environment node */
import "../services/meetingUpdateDeliveryRuntime";
import { publicationWorker } from "./meetingPublicationWorker.fixture";
import { publicationDynamoFixture } from "./meetingPublicationDynamo.fixture";
import { publicationHttpFixture } from "./meetingPublicationHttp.fixture";
import { fixture } from "../services/meetingUpdatePlan.fixture";
import { key } from "../types/meetingUpdateDelivery.fixture";

import { updateMeeting } from "../../src/services/meetingUpdateService";
import { projectMeetingUpdateDelivery } from "../../src/services/meetingUpdateStatus";
let mockFixture: Awaited<ReturnType<typeof publicationDynamoFixture>>;
jest.mock("../../src/db", () => ({
  getMeetingUpdateDeliveryRepository: () => mockFixture.updates,
}));
jest.mock("../../src/services/notionAutomationService", () => ({
  maybeAutoSyncMeetingNotes: async () => undefined,
}));
jest.mock("../../src/services/meetingUpdateDeliveryWorkerService", () => ({
  ...jest.requireActual(
    "../../src/services/meetingUpdateDeliveryWorkerService",
  ),
  verifyMeetingUpdateDeliveryReadiness: async () => undefined,
}));
async function eventually<T>(
  read: () => Promise<T>,
  accept: (value: T) => boolean,
) {
  for (let index = 0; index < 300; index++) {
    const value = await read();
    if (accept(value)) return value;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Local worker did not reach expected durable state");
}
test("actual worker/HTTP held PATCH retains newer save and a fresh worker discovers it without wakeup", async () => {
  mockFixture = await publicationDynamoFixture();
  const input = fixture();
  input.history.status = "complete";
  await mockFixture.put(mockFixture.tables.meetingHistory, input.history);
  // Persist queue discovery fields exactly as a canonical writer would.
  await mockFixture.put(mockFixture.tables.meetingHistory, {
    ...input.history,
    updateDeliveryQueue: "meeting-update:v1",
    updateDeliveryDueAt: input.observedAt,
  });
  await mockFixture.admit();
  const http = await publicationHttpFixture({
    botId: input.botId,
    guildId: input.history.guildId,
    channelId: input.history.notesChannelId,
    messages: input.messages,
  });

  const create = () =>
    publicationWorker({
      repository: mockFixture.updates,
      fetchImpl: http.fetchImpl,
    });
  let worker = create();
  const held = http.holdPatch();
  try {
    const polling = worker.poll();
    await held.entered.promise;
    const before = await mockFixture.read();
    expect(before?.updateDelivery?.progress.kind).toBe("running");
    const saved = await updateMeeting({
      key,
      actor: { editedBy: "synthetic-editor" },
      mutation: {
        kind: "notes",
        notes: "Newer queued notes",
        notesDelta: null,
      },
      notesEdit: { expectedNotesVersion: 2, source: { type: "web_editor" } },
    });
    expect(saved.kind).toBe("saved");
    held.tail.release();
    await polling;
    const first = await eventually(
      () => mockFixture.read(),
      (row) => row?.updateDelivery?.lastSuccess?.contentRevision === 1,
    );
    expect(first?.updateDelivery?.parts.notesBody).toEqual({
      desired: 2,
      acknowledged: 1,
    });
    expect(projectMeetingUpdateDelivery(first!)).toMatchObject({
      status: "pending",
      desiredRevision: 2,
      syncedRevision: null,
      lastSuccess: { contentRevision: 1 },
    });
    await worker.stop();
    worker = create();
    await worker.poll();
    const final = await eventually(
      () => mockFixture.read(),
      (row) => row?.updateDelivery?.progress.kind === "synced",
    );
    expect(final?.notes).toBe("Newer queued notes");
    expect(projectMeetingUpdateDelivery(final!)).toMatchObject({
      status: "synced",
      desiredRevision: 2,
      syncedRevision: 2,
      lastSuccess: { contentRevision: 2 },
    });
    expect(http.writes.filter(({ method }) => method === "PATCH")).toHaveLength(
      2,
    );
  } finally {
    held.tail.release();
    await worker.stop();
    await http.close();
    await mockFixture.close();
  }
});
