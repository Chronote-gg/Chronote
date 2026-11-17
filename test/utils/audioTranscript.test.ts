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
  test("final nonspeech rejection defeats every older guess without a failure", () => {
    const coverage = {
      pcmSha256: "synthetic-pcm",
      audioBytes: 4,
      policyFingerprint: "test-policy",
    };
    const rejected = file({
      transcript: "old guess",
      slowTranscript: "",
      fastTranscripts: [
        { revision: 1, text: "older guess", createdAt: "2026-11-16T00:00:00Z" },
      ],
      finalSpeechRejection: coverage,
    });
    const audioContaining = (entry: AudioFileData): AudioData => ({
      currentSnippets: new Map(),
      audioFiles: [entry],
    });
    expect(resolveAudioFileText(rejected)).toBe("");
    expect(
      getAudioTranscriptionFacts(audioContaining(rejected)).failedSegments,
    ).toBe(0);
  });
  test("a guard-suppressed slow result stays empty despite earlier fast text", () => {
    expect(
      resolveAudioFileText(
        file({
          slowTranscript: "",
          transcript: "",
          fastTranscripts: [
            {
              revision: 1,
              text: "fast guess",
              createdAt: "2026-11-16T00:00:00Z",
            },
          ],
        }),
      ),
    ).toBe("");
  });
  test("uses the latest fast text while the slow result is pending", () => {
    expect(
      resolveAudioFileText(
        file({
          processing: true,
          fastTranscripts: [
            {
              revision: 1,
              text: "fast guess",
              createdAt: "2026-11-16T00:00:00Z",
            },
          ],
        }),
      ),
    ).toBe("fast guess");
  });
  test.each([false, true])(
    "counts spoken user chat with captureIncomplete=%s",
    (captureIncomplete) => {
      const audio = {
        currentSnippets: new Map(),
        audioFiles: [
          file({ transcript: "User contribution", source: "chat_tts" }),
          file({ transcript: "Bot response", source: "bot" }),
        ],
        captureIncomplete,
      } as AudioData;
      expect(getAudioTranscriptionFacts(audio)).toEqual({
        usableSegments: 1,
        failedSegments: 0,
        captureIncomplete,
      });
    },
  );
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
