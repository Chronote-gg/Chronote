import { promises as fs } from "node:fs";
import path from "node:path";
import type { MeetingHistory } from "../types/db";
import type { RecordingCheckpoint } from "../types/recordingCheckpoint";
import type { TranscriptPayload } from "../types/transcript";
import { stableJson } from "../utils/stableJson";
import {
  downloadObjectToFile,
  fetchJsonFromS3,
  uploadObjectToS3,
} from "./storageService";
import {
  resolveTranscriptionInputs,
  runFfmpeg,
  transcribeAudioFiles,
} from "./personalMediaUploadProcessingService";
import { ensureTempBaseDir } from "./tempFileService";

export const UNATTRIBUTED_TRANSCRIPT_NOTICE =
  "This transcript was recovered after the meeting from the mixed channel recording, so speaker attribution is unavailable. Do not attribute statements, decisions, assignments or follow-ups to specific participants unless the speech itself names who is speaking or responsible. Note in the notes that speakers could not be identified.";

/** Transcribes the whole mixed recording; any failed chunk fails the run. */
export async function transcribeMixedRecording(
  audioS3Key: string,
  signal: AbortSignal,
): Promise<{ text: string } | "source_missing"> {
  const workDir = await fs.mkdtemp(
    path.join(await ensureTempBaseDir(), "processing-retry-"),
  );
  try {
    const sourcePath = path.join(
      workDir,
      `source${path.posix.extname(audioS3Key)}`,
    );
    if (!(await downloadObjectToFile(audioS3Key, sourcePath, signal)))
      return "source_missing";
    const audioPath = path.join(workDir, "audio.mp3");
    await runFfmpeg(sourcePath, audioPath, signal);
    const chunks = await resolveTranscriptionInputs(audioPath, workDir, signal);
    const { text } = await transcribeAudioFiles(chunks, false, signal);
    return { text };
  } finally {
    await fs.rm(workDir, { recursive: true, force: true });
  }
}

function folderOf(key: string) {
  return key.slice(0, key.lastIndexOf("/") + 1);
}

export function retryTranscriptKey(
  history: Pick<MeetingHistory, "audioS3Key" | "transcriptS3Key"> & {
    checkpoint?: Pick<RecordingCheckpoint, "artifactFolder">;
  },
  jobId: string,
): string {
  const folder =
    history.checkpoint?.artifactFolder ??
    (history.audioS3Key && folderOf(history.audioS3Key)) ??
    (history.transcriptS3Key && folderOf(history.transcriptS3Key));
  if (folder === undefined)
    throw new Error("Meeting has no artifact folder for a retry transcript");
  return `${folder}transcript-retry-${jobId}.json`;
}

/**
 * Writes once per job. A second claimant of the same job may find its own
 * identical transcript already stored, which counts as success.
 */
export async function storeRetryTranscript(
  key: string,
  payload: TranscriptPayload,
  signal: AbortSignal,
): Promise<void> {
  const stored = await uploadObjectToS3(
    key,
    JSON.stringify(payload),
    "application/json",
    { immutable: true, signal },
  );
  if (stored) return;
  const existing = await fetchJsonFromS3<TranscriptPayload>(key, signal);
  if (existing === undefined || stableJson(existing) !== stableJson(payload))
    throw new Error("Retry transcript key holds a different transcript");
}
