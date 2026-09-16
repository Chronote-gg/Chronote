import {
  classifyTranscription,
  getMeetingProcessingNotice,
  EMPTY_RECORDING_NOTICE,
  PARTIAL_TRANSCRIPT_NOTICE,
} from "../../src/utils/meetingProcessing";

test.each([
  [0, 0, false, "empty"],
  [1, 0, false, "ready"],
  [1, 1, false, "partial"],
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
