import providerPlan from "./terraformMeetingUpdate-provider.json";
// AWS 6.69.1 native mock plan shape. Synthetic resource names and the mocked
// computed region are rebound to the guard's fixed Sandbox identity.
export const identity = { accountId: "123456789012", region: "us-east-1" };
export const tableName = "meeting-notes-sandbox-MeetingHistoryTable";
export const tableArn = `arn:aws:dynamodb:us-east-1:${identity.accountId}:table/${tableName}`;
export function meetingUpdatePlan() {
  return structuredClone(providerPlan);
}
