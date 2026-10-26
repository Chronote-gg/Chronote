import type { MeetingHistory, PersonalMediaUploadJobRecord } from "../types/db";
import { personalMediaClaimForJob } from "../db";
import { getPersonalMediaUploadRepository } from "../repositories/personalMediaUploadRepository";
import { originalCompletionExportView } from "../types/meetingCanonicalContent";
import { writeMeetingUserIndexForMeetingService } from "./meetingUserIndexService";

export async function writeClaimedPersonalHistory(input: {
  job: PersonalMediaUploadJobRecord;
  history: MeetingHistory;
  instanceId: string;
  terminalJob?: PersonalMediaUploadJobRecord;
  onDurable?: () => void;
  assertActive(job: PersonalMediaUploadJobRecord): void;
  observeFailure(error: unknown): unknown;
}): Promise<MeetingHistory> {
  const { job, history, instanceId, terminalJob, onDurable } = input;
  input.assertActive(job);
  const result = await getPersonalMediaUploadRepository().writeHistory(
    history,
    personalMediaClaimForJob(job, instanceId),
    terminalJob,
  );
  if (result.kind === "stale") throw new Error("Personal history claim lost");
  const committed = originalCompletionExportView(history, result.history);
  if (terminalJob) onDurable?.();
  input.assertActive(job);
  try {
    await writeMeetingUserIndexForMeetingService(committed);
  } catch (error) {
    console.error(
      "Failed to index personal meeting history",
      input.observeFailure(error),
    );
  }
  return committed;
}
