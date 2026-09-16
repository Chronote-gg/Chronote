import {
  propagateAttributes,
  startActiveObservation,
  updateActiveObservation,
} from "@langfuse/tracing";
import type { MeetingProcessingOutcome } from "../types/meetingProcessing";
import type { PersonalMediaUploadJobRecord } from "../types/db";
import { isLangfuseTracingEnabled } from "../services/langfuseClient";
import { toLangfuseAttributeMetadata } from "./langfuseMetadata";

export type PersonalUploadTerminalFacts = {
  processing: MeetingProcessingOutcome;
  failedChunks: number;
  processedSegmentCount: number;
  segmentCount: number;
  jobStatus: "complete" | "failed";
};

export async function withPersonalUploadProcessingTrace(
  job: PersonalMediaUploadJobRecord,
  run: () => Promise<void>,
) {
  if (!isLangfuseTracingEnabled()) {
    await run();
    return;
  }
  const metadata = {
    uploadId: job.uploadId,
    mediaKind: job.mediaKind,
    uploadOrigin: job.uploadOrigin,
    attempt: job.attempts ?? 1,
  };
  await propagateAttributes(
    {
      traceName: "personal-upload-processing",
      userId: job.ownerUserId,
      sessionId: job.uploadId,
      tags: ["feature:personal_upload"],
      metadata: toLangfuseAttributeMetadata(metadata),
    },
    () =>
      startActiveObservation(
        "personal-upload-processing",
        async () => {
          updateActiveObservation({ metadata }, { asType: "chain" });
          await run();
        },
        { asType: "chain" },
      ),
  );
}

export function recordPersonalUploadTerminal(
  uploadId: string,
  facts: PersonalUploadTerminalFacts,
) {
  const evidence = { uploadId, ...facts };
  if (facts.jobStatus === "failed") {
    console.error(
      "Personal upload processing reached a terminal outcome",
      evidence,
    );
  } else {
    console.log(
      "Personal upload processing reached a terminal outcome",
      evidence,
    );
  }
  if (!isLangfuseTracingEnabled()) return;
  try {
    updateActiveObservation(
      {
        metadata: facts,
        ...(facts.jobStatus === "failed" ||
        facts.processing.transcription === "failed" ||
        facts.processing.notes === "failed" ||
        facts.processing.summary === "failed"
          ? {
              level: "ERROR" as const,
              statusMessage: "Personal upload processing failed",
            }
          : facts.processing.transcription === "partial"
            ? {
                level: "WARNING" as const,
                statusMessage: "Personal upload transcription partial",
              }
            : {}),
      },
      { asType: "chain" },
    );
  } catch {
    console.warn("Personal upload processing telemetry unavailable", {
      uploadId,
    });
  }
}
