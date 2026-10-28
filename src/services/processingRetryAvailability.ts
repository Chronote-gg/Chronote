import { CONFIG_KEYS } from "../config/keys";
import { getProcessingRetryIndexStatus } from "../repositories/processingRetryRepository";
import { PROCESSING_RETRY_DUE_INDEX } from "../types/meetingProcessingRetry";
import {
  getSnapshotBoolean,
  resolveConfigSnapshot,
} from "./unifiedConfigService";

export async function isProcessingRetryEnabled(): Promise<boolean> {
  const snapshot = await resolveConfigSnapshot({});
  return getSnapshotBoolean(
    snapshot,
    CONFIG_KEYS.meetings.processingRetryEnabled,
  );
}

/** The flag alone is not enough: queued jobs are only found through the due index. */
export async function isProcessingRetryAvailable(): Promise<boolean> {
  if (!(await isProcessingRetryEnabled())) return false;
  try {
    return (await getProcessingRetryIndexStatus()) === "ACTIVE";
  } catch (error) {
    console.warn(`Could not read ${PROCESSING_RETRY_DUE_INDEX} status`, error);
    return false;
  }
}
