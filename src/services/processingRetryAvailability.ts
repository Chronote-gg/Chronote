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

const INDEX_STATUS_CACHE_MS = 60_000;
let indexCheck: { expiresAt: number; active: Promise<boolean> } | undefined;

async function readDueIndexActive(): Promise<boolean> {
  try {
    return (await getProcessingRetryIndexStatus()) === "ACTIVE";
  } catch (error) {
    console.warn(`Could not read ${PROCESSING_RETRY_DUE_INDEX} status`, error);
    return false;
  }
}

/** Cached per process so meeting detail loads and the worker poll do not each call DescribeTable. */
function isDueIndexActive(): Promise<boolean> {
  const now = Date.now();
  if (!indexCheck || indexCheck.expiresAt <= now)
    indexCheck = {
      expiresAt: now + INDEX_STATUS_CACHE_MS,
      active: readDueIndexActive(),
    };
  return indexCheck.active;
}

/** The flag alone is not enough: queued jobs are only found through the due index. */
export async function isProcessingRetryAvailable(): Promise<boolean> {
  if (!(await isProcessingRetryEnabled())) return false;
  return isDueIndexActive();
}
