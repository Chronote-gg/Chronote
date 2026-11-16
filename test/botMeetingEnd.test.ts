/** @jest-environment node */
import type { Client } from "discord.js";
import type { MeetingData } from "../src/types/meeting-data";

const mockFinish = jest.fn<Promise<void>, unknown[]>(async () => undefined);
jest.mock("../src/commands/endMeeting", () => ({
  handleEndMeetingOther: (...args: unknown[]) => mockFinish(...args),
}));

import { endMeetingWithNotice } from "../src/botMeetingEnd";

const client = {} as Client;
const settle = () => new Promise((resolve) => setImmediate(resolve));
function meeting(
  send: () => Promise<{ id: string }>,
  isAutoRecording = false,
): MeetingData {
  return {
    meetingId: "synthetic-meeting",
    isAutoRecording,
    textChannel: { send },
  } as unknown as MeetingData;
}

beforeEach(() => {
  mockFinish.mockReset();
  mockFinish.mockResolvedValue(undefined);
});

test("a rejected notice does not prevent the finish and is logged without its details", async () => {
  const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
  const target = meeting(async () => {
    throw new Error("private transport details");
  });
  await endMeetingWithNotice(client, target, "ending");
  await settle();
  expect(mockFinish).toHaveBeenCalledWith(client, target);
  expect(warn.mock.calls).toEqual([
    ["Meeting end notice failed:", { stage: "send" }],
  ]);
  warn.mockRestore();
});

test("a synchronous transport throw is contained", async () => {
  const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
  const target = meeting(() => {
    throw new Error("private transport details");
  });
  await endMeetingWithNotice(client, target, "ending");
  await settle();
  expect(mockFinish).toHaveBeenCalledTimes(1);
  expect(warn).toHaveBeenCalledTimes(1);
  warn.mockRestore();
});

test("a notice that never settles does not delay the finish", async () => {
  const target = meeting(() => new Promise(() => {}));
  await endMeetingWithNotice(client, target, "ending");
  expect(mockFinish).toHaveBeenCalledTimes(1);
});

test("a manual meeting's notice stays visible", async () => {
  const target = meeting(async () => ({ id: "synthetic-notice" }));
  await endMeetingWithNotice(client, target, "ending");
  await settle();
  expect(target.messagesToDelete).toBeUndefined();
});

test("an auto-recording's notice is handed to the finish for deletion if cancelled", async () => {
  const target = meeting(async () => ({ id: "synthetic-notice" }), true);
  await endMeetingWithNotice(client, target, "ending");
  await settle();
  expect(target.messagesToDelete).toEqual(["synthetic-notice"]);
});

test("a finish failure propagates", async () => {
  const failure = new Error("synthetic finish failure");
  mockFinish.mockRejectedValueOnce(failure);
  await expect(
    endMeetingWithNotice(
      client,
      meeting(async () => ({ id: "synthetic-notice" })),
      "ending",
    ),
  ).rejects.toBe(failure);
});
