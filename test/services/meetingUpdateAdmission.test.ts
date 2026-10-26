/** @jest-environment node */
import { history, key } from "../types/meetingUpdateDelivery.fixture";
import { updateMeeting } from "../../src/services/meetingUpdateService";
const mockRepository = {
  getStrong: jest.fn(),
  updateContentAndDelivery: jest.fn(),
};
const mockReady = jest.fn(async () => undefined);
const mockNotion = jest.fn(async () => undefined);
jest.mock("../../src/db", () => ({
  getMeetingUpdateDeliveryRepository: () => mockRepository,
}));
jest.mock("../../src/services/meetingUpdateDeliveryWorkerService", () => ({
  verifyMeetingUpdateDeliveryReadiness: () => mockReady(),
}));
jest.mock("../../src/services/notionAutomationService", () => ({
  maybeAutoSyncMeetingNotes: () => mockNotion(),
}));
function deferred() {
  let release: () => void = () => {
    throw new Error("Uninitialized deferred");
  };
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
beforeEach(() => {
  jest.clearAllMocks();
  mockReady.mockResolvedValue(undefined);
  mockRepository.getStrong.mockResolvedValue({
    ...history(),
    status: "complete",
    notesVersion: 1,
  });
});
test("cancellation during held readiness cannot admit a later canonical write", async () => {
  const ready = deferred(),
    entered = deferred(),
    controller = new AbortController();
  mockReady.mockImplementationOnce(async () => {
    entered.release();
    await ready.promise;
  });
  const saving = updateMeeting({
    key,
    actor: { editedBy: "synthetic" },
    mutation: { kind: "notes", notes: "Edited" },
    notesEdit: { expectedNotesVersion: 1 },
    signal: controller.signal,
  });
  await entered.promise;
  controller.abort(new Error("Cancelled while readiness held"));
  ready.release();
  await expect(saving).rejects.toThrow("Cancelled");
  expect(mockRepository.updateContentAndDelivery).not.toHaveBeenCalled();
  expect(mockNotion).not.toHaveBeenCalled();
});
test("unexpected canonical database failure remains an error and never becomes conflict or Notion work", async () => {
  mockRepository.updateContentAndDelivery.mockRejectedValueOnce(
    new Error("Unexpected database failure"),
  );
  await expect(
    updateMeeting({
      key,
      actor: { editedBy: "synthetic" },
      mutation: { kind: "notes", notes: "Edited" },
      notesEdit: { expectedNotesVersion: 1 },
    }),
  ).rejects.toThrow("Unexpected database failure");
  expect(mockNotion).not.toHaveBeenCalled();
});
