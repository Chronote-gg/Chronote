import {
  DeleteItemCommand,
  type DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
  TransactWriteItemsCommand,
  type TransactWriteItem,
} from "@aws-sdk/client-dynamodb";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";
import { z } from "zod";
import { config } from "../services/configService";
import type { ActiveMeetingLease, MeetingHistory } from "../types/db";
import type { DeploymentControlRecord } from "../types/deploymentControl";
import type { SessionReservation } from "../types/meetingHistoryTransition";
import { renewActiveMeetingLeaseWrite } from "./activeMeetingLeaseRenewal";
import {
  classifyDeploymentTransactionError,
  completeConditionalCancellation,
} from "./deploymentControlErrors";
import { dynamoDbClient, tableName } from "./dynamoClient";
import { buildInitialMeetingHistoryPut } from "./meetingHistoryTransitions";
import { getMockStore } from "./mockStore";

export type LeaseOwnership = Pick<
  SessionReservation,
  | "guildId"
  | "meetingId"
  | "ownerInstanceId"
  | "executionVersion"
  | "voiceOperationAttemptId"
  | "sessionMode"
>;
export type LeaseSnapshot = Pick<
  ActiveMeetingLease,
  | "status"
  | "endReason"
  | "endTriggeredByUserId"
  | "cancellationReason"
  | "endedAt"
>;
export type SuppressionCheck = { channelId: string; expectedVersion?: number };
export type SuppressionState = { version: number; suppressed: boolean };
export type StartSessionResult = "admitted" | "active_session" | "suppressed";
export type LeaseRenewal = {
  leaseExpiresAt: number;
  expiresAt: number;
  updatedAt: string;
  snapshot: LeaseSnapshot;
};
export type MeetingLeaseRepository = {
  /** One TransactWriteItems, ClientRequestToken = voiceOperationAttemptId. */
  startSession(input: {
    lease: ActiveMeetingLease;
    history?: MeetingHistory;
    suppression?: SuppressionCheck;
    now: number;
    signal?: AbortSignal;
  }): Promise<StartSessionResult>;
  /** False when the condition failed; a thrown error leaves the outcome unknown. */
  renew(
    ownership: LeaseOwnership,
    next: LeaseRenewal,
    now: number,
    signal?: AbortSignal,
  ): Promise<boolean>;
  /**
   * Refuses while another meeting holds a live lease, and refuses when an item
   * naming this meeting holds a different stop request than `lease` carries, so
   * a request that arrived after the caller's read is never overwritten.
   */
  retake(
    lease: ActiveMeetingLease,
    now: number,
    signal?: AbortSignal,
  ): Promise<boolean>;
  release(ownership: LeaseOwnership, signal?: AbortSignal): Promise<boolean>;
  read(
    guildId: string,
    signal?: AbortSignal,
  ): Promise<ActiveMeetingLease | undefined>;
  /** Callers pass only a channel, so the start reads the version its check must match. */
  readSuppression(
    guildId: string,
    channelId: string,
    signal?: AbortSignal,
  ): Promise<SuppressionState | undefined>;
};
export type MeetingLeaseTables = {
  activeMeeting: string;
  meetingHistory: string;
  deploymentControl: string;
};

const suppressionStateSchema = z.object({
  recordType: z.literal("suppression"),
  version: z.number(),
  suppressed: z.boolean(),
});
const suppressionKey = (guildId: string, channelId: string) => ({
  pk: `SUPPRESS#${guildId}`,
  sk: `CHANNEL#${channelId}`,
});
function toSuppressionState(row: unknown): SuppressionState | undefined {
  const parsed = suppressionStateSchema.safeParse(row);
  return parsed.success
    ? { version: parsed.data.version, suppressed: parsed.data.suppressed }
    : undefined;
}
function suppressionAllows(
  state: SuppressionState | undefined,
  expectedVersion?: number,
): boolean {
  if (expectedVersion === undefined) return !state;
  return state?.version === expectedVersion && !state.suppressed;
}
function attemptOf(lease: ActiveMeetingLease): string {
  if (!lease.voiceOperationAttemptId)
    throw new Error("A session lease requires a voice operation attempt id");
  return lease.voiceOperationAttemptId;
}
function retakeCondition(lease: ActiveMeetingLease): string {
  const endRequestUnchanged = lease.endRequestedAt
    ? "endRequestedAt = :endRequestedAt"
    : "attribute_not_exists(endRequestedAt)";
  return `attribute_not_exists(guildId) OR ((leaseExpiresAt < :now OR (meetingId = :meeting AND ownerInstanceId = :owner)) AND (meetingId <> :meeting OR ${endRequestUnchanged}))`;
}

async function conditionHeld(write: () => Promise<unknown>): Promise<boolean> {
  try {
    await write();
    return true;
  } catch (error) {
    if (classifyDeploymentTransactionError(error) === "stale") return false;
    throw error;
  }
}

export function createDynamoMeetingLeaseRepository(
  client: DynamoDBClient,
  tables: MeetingLeaseTables,
): MeetingLeaseRepository {
  return {
    async startSession({ lease, history, suppression, now, signal }) {
      const items: TransactWriteItem[] = [
        {
          Put: {
            TableName: tables.activeMeeting,
            Item: marshall(lease, { removeUndefinedValues: true }),
            ConditionExpression:
              "attribute_not_exists(guildId) OR leaseExpiresAt < :now",
            ExpressionAttributeValues: marshall({ ":now": now }),
          },
        },
      ];
      if (history)
        items.push({ Put: buildInitialMeetingHistoryPut(history, tables) });
      if (suppression)
        items.push({
          ConditionCheck: {
            TableName: tables.deploymentControl,
            Key: marshall(suppressionKey(lease.guildId, suppression.channelId)),
            ConditionExpression:
              suppression.expectedVersion === undefined
                ? "attribute_not_exists(pk)"
                : "#version = :version AND #suppressed = :false",
            ...(suppression.expectedVersion === undefined
              ? {}
              : {
                  ExpressionAttributeNames: {
                    "#version": "version",
                    "#suppressed": "suppressed",
                  },
                  ExpressionAttributeValues: marshall({
                    ":version": suppression.expectedVersion,
                    ":false": false,
                  }),
                }),
          },
        });
      try {
        await client.send(
          new TransactWriteItemsCommand({
            TransactItems: items,
            ClientRequestToken: attemptOf(lease),
          }),
          { abortSignal: signal },
        );
        return "admitted";
      } catch (error) {
        const reasons = completeConditionalCancellation(error, items.length);
        if (!reasons) throw error;
        const failed = (index: number) =>
          reasons[index]?.Code === "ConditionalCheckFailed";
        // The lease is item 0 and the history row item 1; either means a session holds this server.
        if (failed(0) || (history && failed(1))) return "active_session";
        return "suppressed";
      }
    },
    renew(ownership, next, now, signal) {
      const names: Record<string, string> = {};
      const values: Record<string, unknown> = {
        ":now": now,
        ":meeting": ownership.meetingId,
        ":owner": ownership.ownerInstanceId,
        ":version": ownership.executionVersion,
        ":sessionMode": ownership.sessionMode,
      };
      const fields = {
        leaseExpiresAt: next.leaseExpiresAt,
        expiresAt: next.expiresAt,
        updatedAt: next.updatedAt,
        ...next.snapshot,
      };
      const updates = Object.entries(fields)
        .filter(([, value]) => value !== undefined)
        .map(([field, value], index) => {
          names[`#f${index}`] = field;
          values[`:f${index}`] = value;
          return `#f${index} = :f${index}`;
        });
      return renewActiveMeetingLeaseWrite(
        client,
        {
          TableName: tables.activeMeeting,
          Key: marshall({ guildId: ownership.guildId }),
          UpdateExpression: `SET ${updates.join(", ")}`,
          ConditionExpression:
            "leaseExpiresAt >= :now AND meetingId = :meeting AND ownerInstanceId = :owner AND executionVersion = :version AND sessionMode = :sessionMode",
          ExpressionAttributeNames: names,
          ExpressionAttributeValues: marshall(values),
        },
        signal,
        () => now,
      );
    },
    retake(lease, now, signal) {
      return conditionHeld(() =>
        client.send(
          new PutItemCommand({
            TableName: tables.activeMeeting,
            Item: marshall(lease, { removeUndefinedValues: true }),
            ConditionExpression: retakeCondition(lease),
            ExpressionAttributeValues: marshall({
              ":now": now,
              ":meeting": lease.meetingId,
              ":owner": lease.ownerInstanceId,
              ...(lease.endRequestedAt
                ? { ":endRequestedAt": lease.endRequestedAt }
                : {}),
            }),
          }),
          { abortSignal: signal },
        ),
      );
    },
    release(ownership, signal) {
      return conditionHeld(() =>
        client.send(
          new DeleteItemCommand({
            TableName: tables.activeMeeting,
            Key: marshall({ guildId: ownership.guildId }),
            ConditionExpression:
              "meetingId = :meeting AND ownerInstanceId = :owner AND voiceOperationAttemptId = :attempt",
            ExpressionAttributeValues: marshall({
              ":meeting": ownership.meetingId,
              ":owner": ownership.ownerInstanceId,
              ":attempt": ownership.voiceOperationAttemptId,
            }),
          }),
          { abortSignal: signal },
        ),
      );
    },
    async read(guildId, signal) {
      signal?.throwIfAborted();
      const result = await client.send(
        new GetItemCommand({
          TableName: tables.activeMeeting,
          Key: marshall({ guildId }),
          ConsistentRead: true,
        }),
        { abortSignal: signal },
      );
      return result.Item
        ? (unmarshall(result.Item) as ActiveMeetingLease)
        : undefined;
    },
    async readSuppression(guildId, channelId, signal) {
      const result = await client.send(
        new GetItemCommand({
          TableName: tables.deploymentControl,
          Key: marshall(suppressionKey(guildId, channelId)),
          ConsistentRead: true,
        }),
        { abortSignal: signal },
      );
      return result.Item
        ? toSuppressionState(unmarshall(result.Item))
        : undefined;
    },
  };
}

export function createMockMeetingLeaseRepository(
  leases: Map<string, ActiveMeetingLease>,
  histories: Map<string, MeetingHistory[]>,
  controlRecords: ReadonlyMap<string, DeploymentControlRecord>,
): MeetingLeaseRepository {
  const readSuppression = async (
    guildId: string,
    channelId: string,
    signal?: AbortSignal,
  ) => {
    signal?.throwIfAborted();
    const key = suppressionKey(guildId, channelId);
    return toSuppressionState(
      controlRecords.get(JSON.stringify([key.pk, key.sk])),
    );
  };
  const owns = (lease: ActiveMeetingLease, ownership: LeaseOwnership) =>
    lease.meetingId === ownership.meetingId &&
    lease.ownerInstanceId === ownership.ownerInstanceId;
  return {
    async startSession({ lease, history, suppression, now, signal }) {
      signal?.throwIfAborted();
      attemptOf(lease);
      const current = leases.get(lease.guildId);
      if (
        (current && current.leaseExpiresAt >= now) ||
        (history &&
          histories
            .get(history.guildId)
            ?.some(
              (row) => row.channelId_timestamp === history.channelId_timestamp,
            ))
      )
        return "active_session";
      if (
        suppression &&
        !suppressionAllows(
          await readSuppression(lease.guildId, suppression.channelId),
          suppression.expectedVersion,
        )
      )
        return "suppressed";
      leases.set(lease.guildId, structuredClone(lease));
      if (history)
        histories.set(history.guildId, [
          ...(histories.get(history.guildId) ?? []),
          structuredClone(history),
        ]);
      return "admitted";
    },
    async renew(ownership, next, now, signal) {
      signal?.throwIfAborted();
      const lease = leases.get(ownership.guildId);
      if (
        !lease ||
        lease.leaseExpiresAt < now ||
        !owns(lease, ownership) ||
        lease.executionVersion !== ownership.executionVersion ||
        lease.sessionMode !== ownership.sessionMode
      )
        return false;
      const { snapshot, ...timing } = next;
      Object.assign(
        lease,
        timing,
        Object.fromEntries(
          Object.entries(snapshot).filter(([, value]) => value !== undefined),
        ),
      );
      return true;
    },
    async retake(lease, now, signal) {
      signal?.throwIfAborted();
      const current = leases.get(lease.guildId);
      if (current) {
        const sameMeeting = current.meetingId === lease.meetingId;
        const replaceable =
          current.leaseExpiresAt < now ||
          (sameMeeting && current.ownerInstanceId === lease.ownerInstanceId);
        if (
          !replaceable ||
          (sameMeeting && current.endRequestedAt !== lease.endRequestedAt)
        )
          return false;
      }
      leases.set(lease.guildId, structuredClone(lease));
      return true;
    },
    async release(ownership, signal) {
      signal?.throwIfAborted();
      const lease = leases.get(ownership.guildId);
      if (
        !lease ||
        !owns(lease, ownership) ||
        lease.voiceOperationAttemptId !== ownership.voiceOperationAttemptId
      )
        return false;
      return leases.delete(ownership.guildId);
    },
    async read(guildId, signal) {
      signal?.throwIfAborted();
      const lease = leases.get(guildId);
      return lease ? structuredClone(lease) : undefined;
    },
    readSuppression,
  };
}

let nativeRepository: MeetingLeaseRepository | undefined;
export function getMeetingLeaseRepository(): MeetingLeaseRepository {
  if (!config.mock.enabled) {
    nativeRepository ??= createDynamoMeetingLeaseRepository(dynamoDbClient, {
      activeMeeting: tableName("ActiveMeetingTable"),
      meetingHistory: tableName("MeetingHistoryTable"),
      deploymentControl: tableName("DeploymentControlTable"),
    });
    return nativeRepository;
  }
  const store = getMockStore();
  return createMockMeetingLeaseRepository(
    store.activeMeetingLeases,
    store.meetingHistoryByGuild,
    store.deploymentControlRecords,
  );
}
