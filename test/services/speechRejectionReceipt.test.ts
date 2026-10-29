/** @jest-environment node */
import { fixture } from "../helpers/recordingContentFixture";
import {
  recordSpeechRejection,
  startRecordingContentCheckpoint,
  checkpointCompletedTranscription,
} from "../../src/services/recordingContentService";
import { completedTranscriptionSchema } from "../../src/types/recordingContent";
test("speech rejection receipts survive empty checkpoints and both phases without duplicate retries", async () => {
  const { meeting, artifacts } = await fixture();
  meeting.runtimeConfig!.transcription.speechDetectionMode = "enforce";
  startRecordingContentCheckpoint(meeting);
  await meeting.recordingContentTask;
  const snippet = {
    userId: "speaker",
    timestamp: 2000,
    pcmSpans: [
      { sourceId: "user:speaker", sequence: 0, startByte: 0, endByte: 8 },
    ],
  };
  const coverage = {
    pcmSha256: "a".repeat(64),
    audioBytes: 8,
    policyFingerprint: "b".repeat(64),
  };
  recordSpeechRejection(meeting, snippet, coverage, "fast");
  recordSpeechRejection(meeting, snippet, coverage, "fast");
  recordSpeechRejection(meeting, snippet, coverage, "slow");
  let payload = completedTranscriptionSchema.parse(
    JSON.parse(Buffer.from(artifacts.at(-1)!.bytes).toString()),
  );
  expect(payload.entries).toEqual([]);
  expect(payload.speechRejections).toHaveLength(2);
  expect(payload.speechRejections?.map((r) => r.phase)).toEqual([
    "fast",
    "slow",
  ]);
  expect(payload.speechRejections?.[0]).toMatchObject({
    mode: "enforce",
    decision: "non_speech",
    pcmSha256: coverage.pcmSha256,
    spans: snippet.pcmSpans,
    outcome: "request_skipped",
  });
  meeting.audioData.audioFiles.push({
    userId: "speaker",
    timestamp: 2000,
    finalSpeechRejection: coverage,
    terminalOmission: { kind: "pcm", spans: snippet.pcmSpans },
    processing: false,
    audioOnlyProcessing: false,
  });
  checkpointCompletedTranscription(meeting);
  payload = completedTranscriptionSchema.parse(
    JSON.parse(Buffer.from(artifacts.at(-1)!.bytes).toString()),
  );
  expect(
    payload.speechRejections?.every((r) => r.outcome === "final_omission"),
  ).toBe(true);
  const { speechRejections, speechRejectionEvidenceIncomplete, ...legacy } =
    payload;
  expect(speechRejections).toHaveLength(2);
  expect(speechRejectionEvidenceIncomplete).toBe(false);
  expect(
    completedTranscriptionSchema.parse(legacy).speechRejections,
  ).toBeUndefined();
});

test("missing rejection correspondence reports incomplete evidence without stopping recording", async () => {
  const { meeting, artifacts } = await fixture();
  meeting.runtimeConfig!.transcription.speechDetectionMode = "enforce";
  startRecordingContentCheckpoint(meeting);
  await meeting.recordingContentTask;
  const error = jest.spyOn(console, "error").mockImplementation(() => {});
  expect(() =>
    recordSpeechRejection(
      meeting,
      { userId: "speaker", timestamp: 2000 },
      {
        pcmSha256: "a".repeat(64),
        audioBytes: 8,
        policyFingerprint: "b".repeat(64),
      },
      "slow",
    ),
  ).not.toThrow();
  const payload = completedTranscriptionSchema.parse(
    JSON.parse(Buffer.from(artifacts.at(-1)!.bytes).toString()),
  );
  expect(payload.speechRejectionEvidenceIncomplete).toBe(true);
  expect(payload.speechRejections).toEqual([]);
  expect(error).toHaveBeenCalled();
  error.mockRestore();
});

test.each(["fast", "slow"] as const)(
  "live %s wrapper checkpoints an actual skipped admission",
  async (phase) => {
    const { meeting, artifacts } = await fixture();
    meeting.runtimeConfig!.transcription.speechDetectionMode = "enforce";
    startRecordingContentCheckpoint(meeting);
    await meeting.recordingContentTask;
    const coverage = {
      pcmSha256: "a".repeat(64),
      audioBytes: 8,
      policyFingerprint: "b".repeat(64),
    };
    const prepared =
      await import("../../src/services/transcriptionInputService");
    const consume = jest
      .spyOn(prepared, "withPreparedTranscriptionInput")
      .mockImplementation(async (_request, callback) =>
        callback({
          wavFile: "unused.wav",
          conversionMs: 0,
          coverage,
          admission: {
            kind: "assessed",
            coverage,
            assessment: {
              kind: "non_speech",
              policyFingerprint: coverage.policyFingerprint,
              metrics: {
                peakSpeechProbability: 0,
                maxConsecutiveSpeechFrames: 0,
                scannedFrames: 1,
                totalFrames: 1,
                gain: 1,
              },
            },
          },
        }),
      );
    const actual = jest.requireActual<
      typeof import("../../src/services/transcriptionService")
    >("../../src/services/transcriptionService");
    try {
      const result = await actual.transcribeSnippet(
        meeting,
        {
          userId: "speaker",
          timestamp: 2000,
          chunks: [Buffer.alloc(8)],
          pcmSpans: [
            { sourceId: "user:speaker", sequence: 0, startByte: 0, endByte: 8 },
          ],
        },
        { noiseGateMode: phase },
      );
      expect(result.status).toBe("skipped");
      const payload = completedTranscriptionSchema.parse(
        JSON.parse(Buffer.from(artifacts.at(-1)!.bytes).toString()),
      );
      expect(payload.speechRejections).toHaveLength(1);
      expect(payload.speechRejections?.[0].phase).toBe(phase);
    } finally {
      consume.mockRestore();
      await (
        await import("../../src/services/tempFileService")
      ).cleanupMeetingTempDir(meeting);
    }
  },
);

test("checkpoint queue refusal remains an explicit evidence gap", async () => {
  const { meeting, artifacts } = await fixture();
  meeting.runtimeConfig!.transcription.speechDetectionMode = "enforce";
  startRecordingContentCheckpoint(meeting);
  await meeting.recordingContentTask;
  const original = meeting.recordingCapture!.queueContent;
  const error = jest.spyOn(console, "error").mockImplementation(() => {});
  meeting.recordingCapture!.queueContent = () => false;
  recordSpeechRejection(
    meeting,
    {
      userId: "speaker",
      timestamp: 2000,
      pcmSpans: [
        { sourceId: "user:speaker", sequence: 0, startByte: 0, endByte: 8 },
      ],
    },
    {
      pcmSha256: "a".repeat(64),
      audioBytes: 8,
      policyFingerprint: "b".repeat(64),
    },
    "slow",
  );
  meeting.recordingCapture!.queueContent = original;
  checkpointCompletedTranscription(meeting);
  const payload = completedTranscriptionSchema.parse(
    JSON.parse(Buffer.from(artifacts.at(-1)!.bytes).toString()),
  );
  expect(payload.speechRejectionEvidenceIncomplete).toBe(true);
  expect(error).toHaveBeenCalled();
  error.mockRestore();
});
