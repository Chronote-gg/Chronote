/** @jest-environment node */
import "./meetingUpdateDeliveryRuntime";
jest.mock("../../src/db", () => ({
  getMeetingUpdateDeliveryRepository: jest.fn(),
  getMeetingUpdateDeliveryIndexStatus: jest.fn(async () => "ACTIVE"),
}));
import { getMeetingUpdateDeliveryRepository } from "../../src/db";
import {
  startMeetingUpdateDeliveryWorker,
  stopMeetingUpdateDeliveryWorker,
} from "../../src/services/meetingUpdateDeliveryWorkerService";
test("a late serving callback cannot reopen a sealed worker", async () => {
  const callback = () => startMeetingUpdateDeliveryWorker();
  await stopMeetingUpdateDeliveryWorker();
  callback();
  await Promise.resolve();
  expect(getMeetingUpdateDeliveryRepository).not.toHaveBeenCalled();
});
