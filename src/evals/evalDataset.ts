import { LangfuseAPIError } from "@langfuse/core";
import type { LangfuseClient } from "@langfuse/client";

const NOT_FOUND = 404;

export const UPLOAD_COMMAND = "yarn evals:upload";

/**
 * Fetches an eval dataset, turning the "never seeded" case into an actionable
 * message. Only a 404 is translated: an auth failure or a Langfuse outage must
 * keep its original error rather than being reported as a missing dataset.
 */
export const getEvalDataset = async (
  langfuse: LangfuseClient,
  datasetName: string,
) => {
  try {
    return await langfuse.dataset.get(datasetName);
  } catch (error) {
    if (error instanceof LangfuseAPIError && error.statusCode === NOT_FOUND) {
      throw new Error(
        `Langfuse dataset "${datasetName}" does not exist. Seed it first:\n` +
          `  ${UPLOAD_COMMAND} --dataset ${datasetName} --file <cases.json>\n` +
          `Set LANGFUSE_EVAL_DATASET to run against a different dataset.`,
        { cause: error },
      );
    }
    throw error;
  }
};
