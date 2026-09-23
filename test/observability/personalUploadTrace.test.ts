import { jest } from "@jest/globals";
import {
  recordPersonalUploadTerminal,
  withPersonalUploadProcessingTrace,
} from "../../src/observability/personalUploadTrace";
import { isLangfuseTracingEnabled } from "../../src/services/langfuseClient";
import {
  propagateAttributes,
  startActiveObservation,
  updateActiveObservation,
} from "@langfuse/tracing";

jest.mock("../../src/services/langfuseClient", () => ({
  isLangfuseTracingEnabled: jest.fn(() => false),
}));

jest.mock("@langfuse/tracing", () => ({
  propagateAttributes: jest.fn(
    (_attributes: unknown, run: () => Promise<void>) => run(),
  ),
  startActiveObservation: jest.fn((_name: string, run: () => Promise<void>) =>
    run(),
  ),
  updateActiveObservation: jest.fn(),
}));

const job = {
  uploadId: "upload-1",
  ownerUserId: "user-1",
  status: "processing" as const,
  mediaKind: "audio" as const,
  sourceS3Key: "source.mp3",
  contentType: "audio/mpeg",
  fileSize: 100,
  attempts: 3,
  createdAt: "2026-09-16T00:00:00.000Z",
  updatedAt: "2026-09-16T00:00:00.000Z",
};

beforeEach(() => jest.clearAllMocks());

it("runs directly when tracing is disabled", async () => {
  const run = jest.fn(async () => undefined);

  await withPersonalUploadProcessingTrace(job, run);

  expect(run).toHaveBeenCalledTimes(1);
  expect(propagateAttributes).not.toHaveBeenCalled();
});

it("attaches terminal outcomes and counts to the owner trace", async () => {
  jest.mocked(isLangfuseTracingEnabled).mockReturnValue(true);
  await withPersonalUploadProcessingTrace(job, async () => {
    recordPersonalUploadTerminal("upload-1", {
      processing: {
        transcription: "partial",
        notes: "generated",
        summary: "failed",
      },
      failedChunks: 2,
      processedSegmentCount: 1,
      segmentCount: 3,
      jobStatus: "failed",
    });
  });

  expect(startActiveObservation).toHaveBeenCalledWith(
    "personal-upload-processing",
    expect.any(Function),
    { asType: "chain" },
  );
  expect(updateActiveObservation).toHaveBeenLastCalledWith(
    expect.objectContaining({
      level: "ERROR",
      metadata: {
        processing: {
          transcription: "partial",
          notes: "generated",
          summary: "failed",
        },
        failedChunks: 2,
        processedSegmentCount: 1,
        segmentCount: 3,
        jobStatus: "failed",
      },
    }),
    { asType: "chain" },
  );
});
