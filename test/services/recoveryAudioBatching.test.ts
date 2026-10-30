/** @jest-environment node */
jest.mock("dotenv", () => ({ config: () => ({ parsed: {} }) }));
jest.mock("../../src/services/transcriptionService", () => ({
  ...jest.requireActual("../../src/services/transcriptionService"),
  transcribeContentSnippet: jest.fn(async () => ({
    status: "succeeded",
    text: "Recovered discussion.",
  })),
}));
jest.mock("../../src/services/recoveryTranscriptionProcessing", () => ({
  processRecoveryTranscript: jest.fn(async () => "Recovered discussion."),
}));
import { transcribeContentSnippet } from "../../src/services/transcriptionService";
import { processRecoveryTranscript } from "../../src/services/recoveryTranscriptionProcessing";
import { getCheckpointPcmBudget } from "../../src/services/recordingCheckpointCapture";
import {
  readRecoveryContent,
  recoverTranscript,
} from "../../src/services/meetingRecoveryContent";
import {
  pcmArtifact,
  recoveryFixture,
  savedTranscriptionPrompt,
} from "./meetingRecoveryFixtures";

beforeEach(() => jest.clearAllMocks());

async function recover(
  artifacts: NonNullable<Parameters<typeof recoveryFixture>[1]>["artifacts"],
) {
  const f = await recoveryFixture("", {
    artifacts,
    context: savedTranscriptionPrompt,
    transcript: (saved) => {
      saved.entries = [];
    },
  });
  const signal = new AbortController().signal;
  const content = await readRecoveryContent(f.claim.history, f.reader, signal);
  await recoverTranscript(content, f.reader, signal, (run) => run());
  return f;
}

test("recovery batches contiguous tiny artifacts without losing their PCM provenance", async () => {
  const pieces = Array.from({ length: 10 }, (_, index) =>
    Buffer.alloc(3840, index + 1),
  );
  const f = await recover(
    pieces.map((bytes, sequence) =>
      pcmArtifact("user:456", sequence, bytes, [
        { startOffsetMs: 5000 + sequence * 20, durationMs: 20 },
      ]),
    ),
  );
  expect(transcribeContentSnippet).toHaveBeenCalledTimes(1);
  const call = jest.mocked(transcribeContentSnippet).mock.calls[0];
  expect(call[1].timestamp).toBe(Date.parse(f.claim.history.timestamp) + 5000);
  expect(call[1].chunks).toEqual([Buffer.concat(pieces)]);
  const files = jest.mocked(processRecoveryTranscript).mock.calls[0][2];
  expect(files[0].transcriptCorrespondence).toEqual({
    kind: "pcm",
    spans: pieces.map((bytes, sequence) => ({
      sourceId: "user:456",
      sequence,
      startByte: 0,
      endByte: bytes.length,
    })),
  });
});

test("recovery does not bridge a gap or mix speakers across artifacts", async () => {
  await recover([
    pcmArtifact("user:456", 0, Buffer.alloc(3840, 1), [
      { startOffsetMs: 0, durationMs: 20 },
    ]),
    pcmArtifact("user:456", 1, Buffer.alloc(3840, 2), [
      { startOffsetMs: 40, durationMs: 20 },
    ]),
    pcmArtifact("user:789", 0, Buffer.alloc(3840, 3), [
      { startOffsetMs: 20, durationMs: 20 },
    ]),
  ]);
  expect(transcribeContentSnippet).toHaveBeenCalledTimes(3);
  expect(
    jest
      .mocked(transcribeContentSnippet)
      .mock.calls.map(([, snippet]) => snippet.chunks[0].length),
  ).toEqual([3840, 3840, 3840]);
});

test("recovery keeps cross-artifact batches within the existing 30 second limit", async () => {
  await recover(
    [0, 1].map((sequence) =>
      pcmArtifact("user:456", sequence, Buffer.alloc(192000 * 20), [
        { startOffsetMs: sequence * 20000, durationMs: 20000 },
      ]),
    ),
  );
  expect(transcribeContentSnippet).toHaveBeenCalledTimes(2);
});

test.each(["saved", "omitted"])(
  "recovery does not bridge or replay a %s span between artifacts",
  async (kind) => {
    const f = await recoveryFixture("Saved speech.", {
      context: savedTranscriptionPrompt,
      artifacts: [0, 1, 2].map((sequence) =>
        pcmArtifact("user:123", sequence, Buffer.alloc(3840, sequence + 1), [
          { startOffsetMs: sequence * 20, durationMs: 20 },
        ]),
      ),
      transcript: (saved) => {
        const correspondence = {
          kind: "pcm" as const,
          spans: [
            { sourceId: "user:123", sequence: 1, startByte: 0, endByte: 3840 },
          ],
        };
        if (kind === "saved") saved.entries[0].correspondence = correspondence;
        else {
          saved.entries = [];
          saved.omitted = correspondence;
        }
      },
    });
    const signal = new AbortController().signal;
    const content = await readRecoveryContent(
      f.claim.history,
      f.reader,
      signal,
    );
    await recoverTranscript(content, f.reader, signal, (run) => run());
    expect(transcribeContentSnippet).toHaveBeenCalledTimes(2);
    expect(
      jest
        .mocked(transcribeContentSnippet)
        .mock.calls.map(([, snippet]) => snippet.chunks[0][0]),
    ).toEqual([1, 3]);
  },
);

test.each(["missing", "cancelled"])(
  "a %s later slice releases the batch reservation without provider dispatch",
  async (failure) => {
    const f = await recoveryFixture("", {
      context: savedTranscriptionPrompt,
      artifacts: [0, 1].map((sequence) =>
        pcmArtifact("user:456", sequence, Buffer.alloc(3840), [
          { startOffsetMs: sequence * 20, durationMs: 20 },
        ]),
      ),
      transcript: (saved) => {
        saved.entries = [];
      },
    });
    const controller = new AbortController();
    const content = await readRecoveryContent(
      f.claim.history,
      f.reader,
      controller.signal,
    );
    const read = f.reader.readVerifiedObject;
    let reads = 0;
    jest
      .spyOn(f.reader, "readVerifiedObject")
      .mockImplementation(async (...args) => {
        if (++reads === 2) {
          if (failure === "cancelled") {
            controller.abort();
            controller.signal.throwIfAborted();
          }
          return undefined;
        }
        return read(...args);
      });
    const before = getCheckpointPcmBudget().reservedBytes;
    await expect(
      recoverTranscript(content, f.reader, controller.signal, (run) => run()),
    ).rejects.toThrow();
    expect(getCheckpointPcmBudget().reservedBytes).toBe(before);
    expect(transcribeContentSnippet).not.toHaveBeenCalled();
  },
);

test("unknown PCM coverage is not batched or submitted", async () => {
  const artifact = pcmArtifact("user:456", 0, Buffer.alloc(3840), [
    { startOffsetMs: 0, durationMs: 20 },
  ]);
  artifact.coverage = { kind: "unknown" };
  await expect(recover([artifact])).rejects.toThrow(
    "Unsupported or unaligned PCM checkpoint",
  );
  expect(transcribeContentSnippet).not.toHaveBeenCalled();
});

test("batched recovery retains speech around a short group the VAD skips", async () => {
  const transcribe = jest.mocked(transcribeContentSnippet);
  transcribe
    .mockResolvedValueOnce({ status: "succeeded", text: "First speech." })
    .mockResolvedValueOnce({ status: "succeeded", text: "Second speech." })
    .mockResolvedValueOnce({
      status: "skipped",
      reason: "non_speech",
      coverage: {
        pcmSha256: "sample",
        audioBytes: 11520,
        policyFingerprint: "policy",
      },
    })
    .mockResolvedValueOnce({ status: "succeeded", text: "Last speech." });
  let sequence = 0;
  await recover(
    [5, 5, 3, 7].flatMap((count, group) =>
      Array.from({ length: count }, (_, index) =>
        pcmArtifact("user:456", sequence++, Buffer.alloc(3840), [
          { startOffsetMs: group * 1000 + index * 20, durationMs: 20 },
        ]),
      ),
    ),
  );
  expect(
    transcribe.mock.calls.map(([, snippet]) => snippet.chunks[0].length),
  ).toEqual([19200, 19200, 11520, 26880]);
  const files = jest.mocked(processRecoveryTranscript).mock.calls[0][2];
  expect(files.map((file) => file.transcript)).toEqual([
    "First speech.",
    "Second speech.",
    "Last speech.",
  ]);
});
