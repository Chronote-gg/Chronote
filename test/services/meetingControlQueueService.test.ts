/** @jest-environment node */
import { enqueueMeetingControlCommand } from "../../src/services/meetingControlQueueService";
import { getRuntimeAdmissionContext } from "../../src/services/runtimeLifecycleService";
import { getMockStore } from "../../src/repositories/mockStore";
import { resetMeetingControlCommandMemoryRepository } from "../../src/repositories/meetingControlCommandRepository";
import { context, control, runtime } from "../deployment/controlFixtures";
jest.mock("../../src/services/runtimeLifecycleService", () => ({
  getRuntimeAdmissionContext: jest.fn(),
}));
const untrusted = {
  requestId: "fixture:11111111-1111-4111-8111-111111111111",
  commandType: "start_meeting" as const,
  userId: "actor",
  input: { serverId: "guild", fixture: true, grantId: "copied" },
};
beforeEach(() => {
  resetMeetingControlCommandMemoryRepository();
  const records = getMockStore().deploymentControlRecords;
  records.clear();
  for (const row of [control, runtime("old")])
    records.set(JSON.stringify([row.pk, row.sk]), row);
  jest.mocked(getRuntimeAdmissionContext).mockResolvedValue(context);
});
test("public enqueue assigns its own ordinary request identity", async () => {
  const command = await enqueueMeetingControlCommand(untrusted);
  expect(command.requestId).not.toBe(untrusted.requestId);
  expect(command.requestId).not.toMatch(/^fixture:/);
});
test("public copied fixture fields do not bypass held ordinary enqueue", async () => {
  getMockStore().deploymentControlRecords.set(
    JSON.stringify(["ENV", "CONTROL"]),
    {
      ...control,
      maintenance: { holdId: "hold", introductionId: "intro", revision: 1 },
    },
  );
  await expect(enqueueMeetingControlCommand(untrusted)).rejects.toThrow();
});
test("owner control enqueue remains available without new serving admission", async () => {
  jest.mocked(getRuntimeAdmissionContext).mockRejectedValue(new Error("held"));
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
