import { classifyDeploymentTransactionError } from "./deploymentControlErrors";

/** Runs a conditional DynamoDB write: false when its condition failed, any other error rethrown. */
export async function conditionalWrite(
  write: () => Promise<unknown>,
): Promise<boolean> {
  try {
    await write();
    return true;
  } catch (error) {
    if (classifyDeploymentTransactionError(error) === "stale") return false;
    throw error;
  }
}
