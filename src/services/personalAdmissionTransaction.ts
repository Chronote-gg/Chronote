import {
  DynamoDBClient,
  TransactWriteItemsCommand,
  TransactionCanceledException,
  type TransactWriteItem,
} from "@aws-sdk/client-dynamodb";
import { completeConditionalCancellation } from "../repositories/deploymentControlErrors";
import type { AdmissionContext } from "../types/deploymentControl";
import { buildRuntimeAdmissionChecks } from "./deploymentControlTransactions";
import { RuntimeAdmissionUnavailable } from "./runtimeAdmissionError";
/** Keep each public personal transition and ordinary admission at one ordering point. */
export async function transactPersonalAdmission(
  client: DynamoDBClient,
  context: AdmissionContext,
  tablePrefix: string,
  writes: TransactWriteItem[],
): Promise<boolean> {
  const checks = buildRuntimeAdmissionChecks(context, {
    deploymentControl: `${tablePrefix}DeploymentControlTable`,
    activeMeeting: `${tablePrefix}ActiveMeetingTable`,
    meetingHistory: `${tablePrefix}MeetingHistoryTable`,
  });
  try {
    await client.send(
      new TransactWriteItemsCommand({ TransactItems: [...checks, ...writes] }),
    );
    return true;
  } catch (error) {
    if (!(error instanceof TransactionCanceledException)) throw error;
    const reasons = completeConditionalCancellation(
      error,
      checks.length + writes.length,
    );
    if (!reasons) throw error;
    if (
      reasons.slice(0, checks.length).some((reason) => reason.Code !== "None")
    )
      throw new RuntimeAdmissionUnavailable("Runtime is not accepting work");
    return false;
  }
}
