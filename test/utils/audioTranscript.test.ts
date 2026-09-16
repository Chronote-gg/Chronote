import { TRANSCRIPTION_FAILURE_PLACEHOLDER } from "../../src/constants";
import {
  getAudioTranscriptionFacts,
  resolveAudioFileText,
} from "../../src/utils/audioTranscript";
import type { AudioData, AudioFileData } from "../../src/types/audio";

const file = (overrides: Partial<AudioFileData> = {}): AudioFileData => ({
  userId: "user-1",
  timestamp: 1,
  processing: false,
  audioOnlyProcessing: false,
  ...overrides,
});

describe("audio transcript selection", () => {
  test("an authoritative empty final pass suppresses older text", () => {
    expect(
      resolveAudioFileText(
        file({ transcript: "old text", finalPassTranscript: "" }),
      ),
    ).toBe("");
  });

  test("retains the valid baseline when optional refinement has no result", () => {
    expect(resolveAudioFileText(file({ slowTranscript: "  baseline  " }))).toBe(
      "baseline",
    );
  });

  test("does not count a failure placeholder as usable speech", () => {
    const audio = {
      currentSnippets: new Map(),
      audioFiles: [
        file({
          transcript: TRANSCRIPTION_FAILURE_PLACEHOLDER,
          transcriptionFailed: true,
        }),
      ],
    } as AudioData;

    expect(getAudioTranscriptionFacts(audio)).toEqual({
      usableSegments: 0,
      failedSegments: 1,
      captureIncomplete: false,
    });
  });

  test("reports partial facts for usable speech plus a terminal failure", () => {
    const audio = {
      currentSnippets: new Map(),
      audioFiles: [
        file({ transcript: "Yes", source: "voice" }),
        file({ transcriptionFailed: true, source: "voice" }),
        file({ transcript: "synthetic", source: "bot" }),
      ],
      captureIncomplete: true,
    } as AudioData;

    expect(getAudioTranscriptionFacts(audio)).toEqual({
      usableSegments: 1,
      failedSegments: 1,
      captureIncomplete: true,
    });
  });
});
