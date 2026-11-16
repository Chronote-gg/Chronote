/** @jest-environment node */
jest.mock("dotenv", () => ({ config: () => ({ parsed: {} }) }));
jest.mock("../../src/audio", () => ({
  startProcessingSnippet: jest.fn(),
  stopRecordingCapture: jest.fn(),
}));
jest.mock("../../src/services/tempFileService", () => ({
  ensureMeetingTempDir: jest.fn(async () => "synthetic/temp"),
}));

import { startProcessingSnippet } from "../../src/audio";
import { prepareLocalFinish } from "../../src/services/meetingClose";
import { ensureMeetingTempDir } from "../../src/services/tempFileService";
import type { MeetingData } from "../../src/types/meeting-data";

// The hand-off itself, through the real audio path and loader, is the lifecycle scenario
// "speech still open when stop is pressed reaches the transcript the notes input carries".
test("a temp directory that cannot be made is logged and the open snippets are still handed off", async () => {
  const warn = jest.spyOn(console, "warn").mockImplementation(() => undefined);
  jest
    .mocked(ensureMeetingTempDir)
    .mockRejectedValueOnce(new Error("synthetic disk full"));
  const meeting = {
    meetingId: "synthetic-meeting",
    audioData: {
      audioFiles: [],
      currentSnippets: new Map([
        ["synthetic-speaker-a", { userId: "synthetic-speaker-a" }],
        ["synthetic-speaker-b", { userId: "synthetic-speaker-b" }],
      ]),
    },
  } as unknown as MeetingData;

  await prepareLocalFinish(meeting);

  expect(jest.mocked(startProcessingSnippet).mock.calls).toEqual([
    [meeting, "synthetic-speaker-a"],
    [meeting, "synthetic-speaker-b"],
  ]);
  expect(warn).toHaveBeenCalledWith(
    "Local finish could not create the meeting temp directory",
    expect.objectContaining({ meetingId: "synthetic-meeting" }),
  );
});
