/** @jest-environment node */
const transition = jest.fn();
jest.mock("../../src/services/activeMeetingLeaseService", () => ({
  getOwnedSessionReservations: () => [],
}));
jest.mock("../../src/services/runtimeLifecycleService", () => ({
  beginRuntimeWork: jest.fn(() => ({ transition, settle: jest.fn() })),
}));
import {
  beginRuntimeWorkClaim,
  getRuntimeWorkAdmissionCheckpoints,
} from "../../src/services/runtimeWorkAdmissionService";

test("recovery work is admitted without an ActiveMeeting lease and counts as recovery processing", async () => {
  const work = beginRuntimeWorkClaim("recovery", "processing-retry:g:c");
  work.claimed();
  expect(transition).toHaveBeenCalledWith("recovery_processing");
  await work.settle();
  expect(getRuntimeWorkAdmissionCheckpoints()).toEqual([]);
});
