import type { MeetingData } from "../../src/types/meeting-data";
import {
  ensureMeetingNotes,
  ensureMeetingSummaries,
} from "../../src/services/meetingNotesService";
import { getNotes } from "../../src/services/notesService";
import { generateMeetingSummaries } from "../../src/services/meetingSummaryService";
import { PARTIAL_TRANSCRIPT_NOTICE } from "../../src/utils/meetingProcessing";

jest.mock("../../src/services/notesService", () => ({ getNotes: jest.fn() }));
jest.mock("../../src/services/meetingSummaryService", () => ({
  generateMeetingSummaries: jest.fn(),
}));
jest.mock("../../src/services/meetingNameService", () => ({
  resolveMeetingNameFromSummary: jest.fn(),
}));

const mockedGetNotes = jest.mocked(getNotes);
const mockedGenerateMeetingSummaries = jest.mocked(generateMeetingSummaries);

function meeting(overrides: Partial<MeetingData> = {}): MeetingData {
  return {
    guildId: "guild",
    meetingId: "meeting",
    generateNotes: true,
    transcribeMeeting: true,
    finalTranscript: "Transcript text",
    processing: { transcription: "ready" },
    guild: { name: "Guild" },
    voiceChannel: { name: "Voice" },
    startTime: new Date("2026-09-16T12:00:00Z"),
    ...overrides,
  } as unknown as MeetingData;
}

beforeEach(() => jest.clearAllMocks());

test("resolves empty transcription once without warning or model work", async () => {
  const value = meeting({
    finalTranscript: "",
    processing: { transcription: "empty" },
  });
  const warnSpy = jest.spyOn(console, "warn").mockImplementation();

  await ensureMeetingNotes(value);
  await ensureMeetingNotes(value);

  expect(mockedGetNotes).not.toHaveBeenCalled();
  expect(value.processing?.notes).toBe("skipped");
  expect(warnSpy).not.toHaveBeenCalled();
  warnSpy.mockRestore();
});

test("generates partial notes once without storing the warning", async () => {
  const value = meeting({ processing: { transcription: "partial" } });
  mockedGetNotes.mockResolvedValue("Useful notes");

  expect(await ensureMeetingNotes(value)).toBe("Useful notes");
  expect(await ensureMeetingNotes(value)).toBe("Useful notes");

  expect(mockedGetNotes).toHaveBeenCalledTimes(1);
  expect(value.notesText).not.toContain(PARTIAL_TRANSCRIPT_NOTICE);
  expect(value.processing?.notes).toBe("generated");
});

test("memoizes a notes failure without selecting empty behavior", async () => {
  const value = meeting({ processing: { transcription: "ready" } });
  const errorSpy = jest.spyOn(console, "error").mockImplementation();
  mockedGetNotes.mockRejectedValue(new Error("model unavailable"));

  await ensureMeetingNotes(value);
  await ensureMeetingNotes(value);

  expect(mockedGetNotes).toHaveBeenCalledTimes(1);
  expect(value.processing).toEqual({ transcription: "ready", notes: "failed" });
  expect(value.notesText).toBeUndefined();
  errorSpy.mockRestore();
});

test("records an invariant failure for an unresolved transcript", async () => {
  const value = meeting({ finalTranscript: undefined, processing: undefined });
  const errorSpy = jest.spyOn(console, "error").mockImplementation();

  await ensureMeetingNotes(value);

  expect(mockedGetNotes).not.toHaveBeenCalled();
  expect(value.processing).toEqual({ notes: "failed" });
  expect(errorSpy).toHaveBeenCalled();
  errorSpy.mockRestore();
});

test("contains summary failure and memoizes it", async () => {
  const value = meeting({
    processing: { transcription: "ready", notes: "generated" },
  });
  const errorSpy = jest.spyOn(console, "error").mockImplementation();
  mockedGenerateMeetingSummaries.mockRejectedValue(
    new Error("summary unavailable"),
  );

  expect(await ensureMeetingSummaries(value, "Useful notes")).toEqual({});
  expect(await ensureMeetingSummaries(value, "Useful notes")).toEqual({});

  expect(mockedGenerateMeetingSummaries).toHaveBeenCalledTimes(1);
  expect(value.processing?.summary).toBe("failed");
  expect(errorSpy).toHaveBeenCalled();
  errorSpy.mockRestore();
});

test("leaves generation outcomes unset when notes are disabled", async () => {
  const value = meeting({
    generateNotes: false,
    processing: { transcription: "empty" },
  });

  await ensureMeetingNotes(value);
  await ensureMeetingSummaries(value, undefined);

  expect(value.processing).toEqual({ transcription: "empty" });
});
