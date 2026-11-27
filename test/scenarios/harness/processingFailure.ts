import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { createDynamoMeetingUpdateDeliveryRepository } from "../../../src/repositories/meetingUpdateDeliveryRepository";
import { createMeetingUpdateService } from "../../../src/services/meetingUpdateService";
import type { MeetingHistory } from "../../../src/types/db";
import type { ProcessingRetryJob } from "../../../src/types/meetingProcessingRetry";
import { epochSeconds, SERVER_A, type Scenario } from "./scenario";
import { scenarioDynamoConfig } from "./tables";

/** Each attempt may retry the call; this outlasts every attempt. */
const MODEL_FAILURES = 1_000;

/** A meeting whose `kind` model calls keep failing, until it ends failed with the notice. */
export async function failEveryAttempt(
  scenario: Scenario,
  startWorker: () => Promise<unknown>,
  kind: "text" | "transcription",
) {
  scenario.scriptReplies();
  await startWorker();
  await startWorker();
  const { row: live } = await scenario.startRecording(SERVER_A);
  const startMessage = await scenario.startMessageOf(SERVER_A, live.meetingId);
  await scenario.speak(scenario.recorder(live), SERVER_A);
  scenario.world.openai.failNext(kind, MODEL_FAILURES);
  const samples = scenario.sampleRow(SERVER_A, live.meetingId);
  await scenario.button("end_meeting", startMessage, SERVER_A);
  await scenario.leaseGone();
  try {
    const failed = await scenario.rowWith(
      SERVER_A,
      (row) =>
        row.meetingId === live.meetingId &&
        row.status === "failed" &&
        row.finish === undefined,
      "meeting failed after its retries",
    );
    return { failed, startMessage, samples };
  } finally {
    await samples.stop();
  }
}

/** The processing retry worker's save of a succeeded job, through the real update action. */
export async function saveRetriedNotes(
  scenario: Scenario,
  failed: MeetingHistory,
  notes: string,
) {
  const prefix = process.env.DDB_TABLE_PREFIX;
  const claim = { ownerInstanceId: "retry-worker", claimId: "retry-claim" };
  const job: ProcessingRetryJob = {
    jobId: "retry-job",
    status: "running",
    stages: ["notes", "summary"],
    requestedBy: SERVER_A.speaker.id,
    requestedAt: new Date().toISOString(),
    expectedNotesVersion: 1,
    replaceNotes: false,
    countedAttempts: 0,
    settingsSource: "snapshot",
    transcriptSource: "existing",
    claim: { ...claim, leaseExpiresAt: epochSeconds() + 300 },
    updatedAt: new Date().toISOString(),
  };
  await scenario.world.rows.seedHistory({ ...failed, processingRetry: job });
  const update = createMeetingUpdateService({
    repository: createDynamoMeetingUpdateDeliveryRepository(
      new DynamoDBClient(scenarioDynamoConfig()),
      {
        meetingHistory: prefix + "MeetingHistoryTable",
        deploymentControl: prefix + "DeploymentControlTable",
      },
    ),
    ready: async () => undefined,
    syncNotes: async () => undefined,
  });
  return update({
    key: {
      guildId: failed.guildId,
      channelId_timestamp: failed.channelId_timestamp,
    },
    mutation: { kind: "regeneration", changes: [{ kind: "notes", notes }] },
    actor: { editedBy: job.requestedBy },
    notesEdit: {
      expectedNotesVersion: 1,
      source: { type: "processing_retry", jobId: job.jobId },
    },
    regeneration: {
      expected: { jobId: job.jobId, ...claim, expectedNotesVersion: 1 },
      processing: {
        transcription: "ready",
        notes: "generated",
        summary: "generated",
      },
      job: {
        ...job,
        status: "succeeded",
        countedAttempts: 1,
        claim: undefined,
      },
    },
  });
}
