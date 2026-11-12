/** @jest-environment node */
import { enqueueMeetingControlCommand } from "../../src/services/meetingControlQueueService";
import { getMockStore } from "../../src/repositories/mockStore";
import {
  getMeetingControlCommandRepository,
  resetMeetingControlCommandMemoryRepository,
} from "../../src/repositories/meetingControlCommandRepository";
const untrusted = {
  requestId: "fixture:11111111-1111-4111-8111-111111111111",
  commandType: "start_meeting" as const,
  userId: "actor",
  input: { serverId: "guild", fixture: true, grantId: "copied" },
};
beforeEach(() => {
  resetMeetingControlCommandMemoryRepository();
  getMockStore().deploymentControlRecords.clear();
});
test("public enqueue assigns its own ordinary request identity", async () => {
  const command = await enqueueMeetingControlCommand(untrusted);
  expect(command.requestId).not.toBe(untrusted.requestId);
  expect(command.requestId).not.toMatch(/^fixture:/);
});
test("a command is enqueued with no deployment control record present", async () => {
  const command = await enqueueMeetingControlCommand(untrusted);
  await expect(
    getMeetingControlCommandRepository().getCommand(command.requestId),
  ).resolves.toMatchObject({
    queueStatus: "pending",
    commandType: "start_meeting",
  });
});
test("owner control enqueue keeps its target owner", async () => {
  await expect(
    enqueueMeetingControlCommand({
      commandType: "stop_meeting",
      userId: "actor",
      input: { serverId: "guild", meetingId: "meeting" },
      targetOwnerInstanceId: "owner",
    }),
  ).resolves.toMatchObject({
    commandType: "stop_meeting",
    targetOwnerInstanceId: "owner",
  });
});
