import type { MeetingData } from "../../src/types/meeting-data";
import {
  assertMeetingProcessingSucceeded,
  classifyTranscription,
  classifyUploadTranscription,
  getMeetingProcessingNotice,
  EMPTY_RECORDING_NOTICE,
  PARTIAL_TRANSCRIPT_NOTICE,
} from "../../src/utils/meetingProcessing";

/** A snippet either transcribed or failed, never both, as production records them. */
function meetingWithSnippets(
  usableSegments: number,
  failedSegments: number,
): MeetingData {
  return {
    transcribeMeeting: true,
    audioData: {
      audioFiles: [
        ...Array.from({ length: usableSegments }, () => ({
          transcript: "usable",
          processing: false,
        })),
        ...Array.from({ length: failedSegments }, () => ({
          transcript: "",
          processing: false,
          transcriptionFailed: true,
        })),
      ],
    },
  } as unknown as MeetingData;
}

test("a couple of lost snippets keep normal finalization", () => {
  expect(() =>
    assertMeetingProcessingSucceeded(meetingWithSnippets(153, 2)),
  ).not.toThrow();
  expect(() =>
    assertMeetingProcessingSucceeded(meetingWithSnippets(153, 3)),
  ).toThrow("incomplete");
});

test.each([undefined, "partial"] as const)(
  "usable incomplete capture can finalize with transcription=%s",
  (transcription) => {
    const meeting = meetingWithSnippets(316, 0);
    meeting.audioData.captureIncomplete = true;
    meeting.processing = { transcription };
    expect(() => assertMeetingProcessingSucceeded(meeting)).not.toThrow();
    expect(meeting.audioData.captureIncomplete).toBe(true);
    expect(meeting.processing.transcription).toBe(transcription);
  },
);

test.each([1, 2])(
  "incomplete capture keeps the existing tolerance for %s failed snippets",
  (failed) => {
    const meeting = meetingWithSnippets(316, failed);
    meeting.audioData.captureIncomplete = true;
    meeting.processing = { transcription: "partial" };
    expect(() => assertMeetingProcessingSucceeded(meeting)).not.toThrow();
  },
);

test.each([
  "no-usable-speech",
  "provider-loss",
  "pending",
  "failed-transcription",
  "failed-notes",
  "failed-summary",
  "unattributed-partial",
] as const)("incomplete capture preserves the %s refusal", (failure) => {
  const meeting = meetingWithSnippets(
    failure === "no-usable-speech" ? 0 : 316,
    failure === "provider-loss" ? 3 : 0,
  );
  meeting.audioData.captureIncomplete = failure !== "unattributed-partial";
  meeting.processing = { transcription: "partial" };
  if (failure === "pending") meeting.audioData.audioFiles[0].processing = true;
  if (failure === "failed-transcription")
    meeting.processing.transcription = "failed";
  if (failure === "failed-notes") meeting.processing.notes = "failed";
  if (failure === "failed-summary") meeting.processing.summary = "failed";
  expect(() => assertMeetingProcessingSucceeded(meeting)).toThrow(
    failure === "pending" ? "pending" : "incomplete",
  );
});

// A wholly failed recording must not reach the accidental-recording classifier, which
// runs before the transcription outcome is written and sees only an empty transcript.
test("a recording whose only snippet failed is never treated as complete", () => {
  expect(() =>
    assertMeetingProcessingSucceeded(meetingWithSnippets(0, 1)),
  ).toThrow("incomplete");
  expect(
    classifyTranscription({
      usableSegments: 0,
      failedSegments: 1,
      captureIncomplete: false,
    }),
  ).toBe("failed");
});

// captureIncomplete still demotes because it now records only decoder, stream and
// subscription loss; a speaking turn without PCM no longer arms it.
test.each([
  [0, 0, false, "empty"],
  [1, 0, false, "ready"],
  [1, 1, false, "ready"],
  [1, 2, false, "ready"],
  [153, 2, false, "ready"],
  [1, 3, false, "partial"],
  [153, 9, false, "partial"],
  [0, 1, false, "failed"],
  [0, 0, true, "failed"],
  [1, 0, true, "partial"],
] as const)(
  "classifies %s/%s/%s",
  (usableSegments, failedSegments, captureIncomplete, expected) => {
    expect(
      classifyTranscription({
        usableSegments,
        failedSegments,
        captureIncomplete,
      }),
    ).toBe(expected);
  },
);

test("uses one empty notice and keeps partial notes readable", () => {
  expect(
    getMeetingProcessingNotice(
      { transcription: "empty", notes: "skipped" },
      false,
    )?.text,
  ).toBe(EMPTY_RECORDING_NOTICE);
  expect(
    getMeetingProcessingNotice(
      { transcription: "partial", notes: "generated" },
      true,
    )?.text,
  ).toBe(PARTIAL_TRANSCRIPT_NOTICE);
  expect(getMeetingProcessingNotice(undefined, false)).toBeUndefined();
});

test("reports transcription failure before notes failure", () => {
  expect(
    getMeetingProcessingNotice(
      { transcription: "failed", notes: "failed" },
      false,
    ),
  ).toEqual({
    tone: "error",
    text: "Audio could not be transcribed, so no notes were generated.",
  });
});

test("does not describe disabled notes generation as a processing problem", () => {
  expect(
    getMeetingProcessingNotice(
      { transcription: "ready", notes: "skipped" },
      false,
    ),
  ).toBeUndefined();
});

test("imported notes suppress an obsolete empty notice", () => {
  expect(
    getMeetingProcessingNotice(
      { transcription: "empty", notes: "skipped" },
      true,
    ),
  ).toBeUndefined();
});

test("an upload's few long chunks demote on a single failure", () => {
  // 300 second chunks, not per-turn snippets: one lost chunk is a real gap, and the
  // Discord floor would call a two chunk upload with one failure "ready".
  const facts = {
    usableSegments: 1,
    failedSegments: 1,
    captureIncomplete: false,
  };
  expect(classifyUploadTranscription(facts)).toBe("partial");
  expect(classifyTranscription(facts)).toBe("ready");
});
