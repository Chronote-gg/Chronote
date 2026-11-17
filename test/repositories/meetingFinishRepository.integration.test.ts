/** @jest-environment node */
import {
  type DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
} from "@aws-sdk/client-dynamodb";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";
import { createDynamoMeetingFinishRepository } from "../../src/repositories/meetingFinishRepository";
import type { MeetingHistory } from "../../src/types/db";
import {
  createScratchTable,
  describeLocalDynamo,
  localDynamoClient,
} from "./localDynamo.fixture";
import {
  type MeetingFinishHarness,
  meetingFinishContract,
} from "./meetingFinishRepository.contract";

/** Throwaway MeetingHistory and ActiveMeeting tables with their real key schemas. */
async function createFinishTables(
  client: DynamoDBClient,
): Promise<MeetingFinishHarness> {
  const history = await createScratchTable(client, "meeting-history", {
    AttributeDefinitions: [
      { AttributeName: "guildId", AttributeType: "S" },
      { AttributeName: "channelId_timestamp", AttributeType: "S" },
    ],
    KeySchema: [
      { AttributeName: "guildId", KeyType: "HASH" },
      { AttributeName: "channelId_timestamp", KeyType: "RANGE" },
    ],
  });
  const lease = await createScratchTable(client, "active-meeting", {
    AttributeDefinitions: [{ AttributeName: "guildId", AttributeType: "S" }],
    KeySchema: [{ AttributeName: "guildId", KeyType: "HASH" }],
  });
  const put = (TableName: string, item: object) =>
    client.send(
      new PutItemCommand({
        TableName,
        Item: marshall(item, { removeUndefinedValues: true }),
      }),
    );
  return {
    repository: createDynamoMeetingFinishRepository(client, {
      meetingHistory: history.TableName,
      activeMeeting: lease.TableName,
    }),
    async seedHistory(row) {
      await put(history.TableName, row);
    },
    async seedLease(item) {
      await put(lease.TableName, item);
    },
    async readHistory(key) {
      const result = await client.send(
        new GetItemCommand({
          TableName: history.TableName,
          Key: marshall(key),
          ConsistentRead: true,
        }),
      );
      return result.Item
        ? (unmarshall(result.Item) as MeetingHistory)
        : undefined;
    },
    async dispose() {
      await Promise.all([history.dispose(), lease.dispose()]);
    },
  };
}

describeLocalDynamo("local Dynamo meeting finish repository", () => {
  const client = localDynamoClient();
  afterAll(() => client.destroy());
  meetingFinishContract(() => createFinishTables(client));
});
