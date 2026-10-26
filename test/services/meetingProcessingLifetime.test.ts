/** @jest-environment node */
import type { MeetingData } from "../../src/types/meeting-data";
import {
  runMeetingProcessingEffect,
  stopMeetingProcessing,
  getMeetingProcessingSignal,
} from "../../src/services/meetingProcessingLifetime";
test("stopping tracks the complete issued effect and prevents reentrant late dispatch", async () => {
  const meeting = {} as MeetingData;
  let complete!: () => void;
  const provider = new Promise<void>((resolve) => {
    complete = resolve;
  });
  let issued = 0;
  const task = runMeetingProcessingEffect(meeting, async () => {
    issued++;
    await provider;
    await expect(
      runMeetingProcessingEffect(meeting, async () => {
        issued++;
      }),
    ).rejects.toThrow();
  });
  await Promise.resolve();
  let settled = false;
  const drain = stopMeetingProcessing(meeting).then(() => {
    settled = true;
  });
  expect(getMeetingProcessingSignal(meeting).aborted).toBe(true);
  await Promise.resolve();
  expect(settled).toBe(false);
  complete();
  await task;
  await drain;
  expect(issued).toBe(1);
});
test("synchronous stop before dispatch fences future provider work", async () => {
  const meeting = {} as MeetingData;
  let issued = false;
  const drain = stopMeetingProcessing(meeting);
  const task = runMeetingProcessingEffect(meeting, async () => {
    issued = true;
  });
  await expect(task).rejects.toThrow();
  await drain;
  expect(issued).toBe(false);
});
