/** @jest-environment node */
import type { MeetingData } from "../src/types/meeting-data";
import { closeFailedInitializationOutput } from "../src/audio";
import { disposeFailedInitialization } from "../src/meetings";

jest.mock("../src/audio", () => ({
  closeFailedInitializationOutput: jest.fn(),
}));

/** Bound by the disposal's own five-second allowance. */
const ALLOWANCE_MS = 5_000;

function held<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** A recording start that failed after its meeting was built. */
function failedStart(closeOutput: () => Promise<boolean>) {
  jest.mocked(closeFailedInitializationOutput).mockImplementation(closeOutput);
  const meeting = {
    meetingId: "synthetic-meeting",
    guildId: "synthetic-guild",
    captureAudio: true,
    recordBotAudio: false,
    audioData: {},
    setFinished: jest.fn(),
  } as unknown as MeetingData;
  return {
    meeting,
    dispose: () => disposeFailedInitialization({ meeting, cleanup: [] }),
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.useFakeTimers();
});
afterEach(() => jest.useRealTimers());

test("a failed recording start closes its encoder at once and settles when the encoder closes within the allowance", async () => {
  const encoder = held<boolean>();
  const f = failedStart(() => encoder.promise);

  const disposed = f.dispose();
  expect(closeFailedInitializationOutput).toHaveBeenCalledTimes(1);
  expect(f.meeting.setFinished).toHaveBeenCalledTimes(1);
  await jest.advanceTimersByTimeAsync(ALLOWANCE_MS - 1_000);
  encoder.resolve(true);

  expect(await disposed).toBe(true);
});

test("an encoder that has not closed when the allowance ends leaves the start unsettled", async () => {
  const f = failedStart(() => new Promise<boolean>(() => undefined));

  const disposed = f.dispose();
  await jest.advanceTimersByTimeAsync(ALLOWANCE_MS);

  expect(await disposed).toBe(false);
});
