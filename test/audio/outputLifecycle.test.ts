import { EventEmitter } from "node:events";
import ffmpeg from "fluent-ffmpeg";
import {
  openOutputFile,
  closeOutputFile,
  closeFailedInitializationOutput,
} from "../../src/audio";
import { ensureMeetingTempDirSync } from "../../src/services/tempFileService";
import type { MeetingData } from "../../src/types/meeting-data";

jest.mock("../../src/services/tempFileService", () => ({
  ensureMeetingTempDirSync: jest.fn(() => "fixture-temp"),
}));
jest.mock("fluent-ffmpeg", () => ({ __esModule: true, default: jest.fn() }));
function fixture() {
  const process = Object.assign(new EventEmitter(), {
    inputOptions() {
      return this;
    },
    audioCodec() {
      return this;
    },
    outputOptions() {
      return this;
    },
    toFormat() {
      return this;
    },
    save() {
      return this;
    },
  });
  jest
    .mocked(ffmpeg)
    .mockReturnValue(process as unknown as ReturnType<typeof ffmpeg>);
  return { process, meeting: { audioData: {} } as MeetingData };
}
test("failed output setup without ffmpeg never hangs cleanup", async () => {
  const { meeting } = fixture();
  jest.mocked(ensureMeetingTempDirSync).mockImplementationOnce(() => {
    throw new Error("fixture temp failure");
  });
  expect(() => openOutputFile(meeting)).toThrow("fixture temp failure");
  expect(meeting.audioData.ffmpegProcess).toBeUndefined();
  let completed = false;
  void closeOutputFile(meeting).then(() => {
    completed = true;
  });
  for (let i = 0; i < 8; i++) await Promise.resolve();
  expect(completed).toBe(true);
});
test.each(["end", "error"])(
  "already observed encoder %s completes later close",
  async (event) => {
    const { meeting, process } = fixture();
    const error = new Error("fixture encoder failure");
    const warning = jest.spyOn(console, "error").mockImplementation(() => {});
    openOutputFile(meeting);
    process.emit(event, error);
    let outcome: unknown;
    void closeOutputFile(meeting).then(
      () => {
        outcome = "closed";
      },
      (caught: unknown) => {
        outcome = caught;
      },
    );
    for (let i = 0; i < 8; i++) await Promise.resolve();
    expect(outcome).toEqual(event === "end" ? "closed" : error);
    if (event === "error")
      expect(warning).toHaveBeenCalledWith("ffmpeg error:", error);
    warning.mockRestore();
  },
);
test("unresolved encoder close is bounded and reports unresolved cleanup", async () => {
  jest.useFakeTimers();
  const { meeting, process } = fixture();
  openOutputFile(meeting);
  const closing = closeFailedInitializationOutput(meeting);
  await jest.advanceTimersByTimeAsync(5_001);
  expect(await closing).toBe(false);
  process.emit("end");
  expect(await closeFailedInitializationOutput(meeting)).toBe(true);
  jest.useRealTimers();
});
