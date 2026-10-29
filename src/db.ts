import type {
  MeetingBrowsePageOptions,
  MeetingBrowsePage,
} from "./types/meetingBrowse";
import { assertRawMeetingIndexUserId } from "./utils/meetingUserIndex";
import {
  buildPendingSegmentTransaction,
  buildPersonalUploadSubmissionTransaction,
  buildPersonalSegmentTransitionTransaction,
} from "./services/personalUploadTransactions";
import { completeConditionalCancellation } from "./repositories/deploymentControlErrors";
import { createStripeWebhookDynamoRepository } from "./repositories/stripeWebhookDynamoRepository";
import { transactPersonalAdmission } from "./services/personalAdmissionTransaction";
import { personalCanonicalWriter } from "./types/meetingCanonicalWriter";
import { canonicalFieldsSupersededAfter } from "./types/meetingCanonicalContent";
import type { PersonalHistoryWriteResult } from "./types/personalHistoryWrite";
import {
  publicationSnapshot,
  publicationSnapshotCondition,
} from "./types/meetingPublication";
import { parseMeetingUpdateHistory } from "./repositories/meetingUpdateDeliveryState";
import { readDynamoIndexStatus } from "./repositories/dynamoIndexStatus";
import {
  bindDeploymentControlRepository,
  bindMeetingUpdateDeliveryRepository,
} from "./repositories/deploymentRepositoryBindings";
import { listUnpausedPersonalMediaUploadJobs } from "./repositories/personalMediaUploadQueue";
import {
  billingChangeControlKey,
  billingChangeOperationKey,
  isBillingChangeComplete,
  type BillingChangeClaim,
  type BillingChangeWrite,
  parseChangeUsage,
} from "./types/billingChange";
import {
  renewalOperationKey,
  renewalControlKey,
  isRenewalComplete,
  type RenewalOperation,
} from "./types/renewal";
import type { IntroOfferAuthority } from "./types/introOfferAuthority";
import { validateBoundarySample } from "./types/historyWriterBoundary";
import {
  historyWriterBoundaryKey,
  HISTORY_WRITER_VERSION,
  historyWriterBoundarySchema,
  type HistoryWriterBoundary,
} from "./types/historyWriterBoundary";
import {
  historicalOfferImportKey,
  historicalOfferImportSchema,
  parseHistoricalOfferImportWrite,
  type HistoricalOfferImport,
  type HistoricalOfferImportWrite,
} from "./types/historicalOfferImport";
import { assertPurchaseInvoiceBinding } from "./types/purchase";
import { z } from "zod";
import {
  offerUsageKey,
  offerUsageSchema,
  parseOfferUsageChange,
  type OfferUsage,
  type IntroOfferId,
  type ProviderMode,
  type OfferUsageWrite,
  type OfferUsageMutation,
} from "./types/offerUsage";
import type { PurchaseAttempt, PurchaseIncident } from "./types/purchase";
import { config } from "./services/configService";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  AttributeValue,
  type Put,
  type ConditionCheck,
  DynamoDBClient,
  TransactWriteItemsCommand,
  TransactionCanceledException,
  GetItemCommand,
  PutItemCommand,
  DeleteItemCommand,
  QueryCommand,
  ScanCommand,
  UpdateItemCommand,
} from "@aws-sdk/client-dynamodb";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";
import {
  AccessLog,
  AutoRecordSettings,
  ChannelContext,
  EntitlementGrant,
  EntitlementGrantStatus,
  GuildSubscription,
  MeetingHistory,
  MeetingAccessGrant,
  MeetingUserIndexRecord,
  AskConversationRecord,
  AskMessageRecord,
  GuildInstaller,
  OnboardingState,
  PaymentTransaction,
  RecordingTranscript,
  ServerContext,
  ActiveMeetingLease,
  StripeWebhookEvent,
  InteractionReceipt,
  UserSpeechSettings,
  ChatTtsMonthlyUsage,
  DictionaryEntry,
  ConfigOverrideRecord,
  AskConversationShareRecord,
  MeetingShareRecord,
  MeetingShareByMeetingRecord,
  FeedbackRecord,
  FeedbackTargetType,
  ContactFeedbackRecord,
  PersonalMediaUploadJobRecord,
  PersonalMediaClaim,
  PersonalRecordingSegmentRecord,
} from "./types/db";
import type { MeetingStatus } from "./types/meetingLifecycle";

import {
  classifyDeploymentTransactionError,
  mockWorkAdmissionAllowed,
} from "./repositories/deploymentControlRepository";
import { getMockStore } from "./repositories/mockStore";
import { requireUnpausedDesktopDraft } from "./repositories/pausedDesktopDraft";
import type {
  AdmissionContext,
  HistoryTransition,
  WorkAdmissionAuthority,
} from "./types/deploymentControl";
import {
  buildWorkAdmissionChecks,
  buildPersonalMediaClaimTransaction,
  buildPersonalClaimCheck,
} from "./services/deploymentControlTransactions";

import {
  renewalRecoveryKey,
  renewalRecoveryCurrentKey,
  RENEWAL_RECOVERY_DUE_INDEX,
  renewalRecoveryNextCheck,
  readRenewalRecoveryCursor,
  writeRenewalRecoveryCursor,
  renewalRecoveryCursorSchema,
  type RenewalRecovery,
  type RenewalRecoveryPointer,
} from "./types/renewalRecovery";

const MEETING_USER_INDEX_WRITE_BATCH_SIZE = 25;
const PERSONAL_MEDIA_UPLOAD_STATUS_UPDATED_AT_INDEX = "StatusUpdatedAtIndex";

export const dynamoDbClient = new DynamoDBClient(
  config.database.useLocalDynamoDB
    ? {
        endpoint: "http://localhost:8000",
        region: "local",
        credentials: {
          accessKeyId: "dummy",
          secretAccessKey: "dummy",
        },
      }
    : { region: "us-east-1" },
);

const tablePrefix = config.database.tablePrefix ?? "";
const tableName = (name: string) => `${tablePrefix}${name}`;
const indexStatus = (table: string, indexName: string) =>
  readDynamoIndexStatus(dynamoDbClient, {
    mock: config.mock.enabled,
    tableName: tableName(table),
    indexName,
  });
export const getMeetingUpdateDeliveryIndexStatus = () =>
  indexStatus("MeetingHistoryTable", "UpdateDeliveryDueIndex");
export const getRenewalRecoveryIndexStatus = () =>
  indexStatus("GuildSubscriptionTable", "RenewalRecoveryDueIndex");
export async function scanGuildSubscriptionPage(
  cursor?: string,
): Promise<{ guildIds: string[]; cursor?: string }> {
  if (config.mock.enabled) {
    const keys = [...getMockStore().subscriptions.keys()]
      .sort()
      .filter((key) => !cursor || key > cursor)
      .slice(0, 100);
    return {
      guildIds: keys.filter((key) => /^\d{17,20}$/.test(key)),
      cursor: keys.length === 100 ? keys.at(-1) : undefined,
    };
  }
  const result = await dynamoDbClient.send(
    new ScanCommand({
      TableName: tableName("GuildSubscriptionTable"),
      ConsistentRead: true,
      Limit: 100,
      ProjectionExpression: "guildId",
      ExclusiveStartKey: cursor
        ? marshall({ guildId: z.string().min(1).parse(cursor) })
        : undefined,
    }),
  );
  const guildIds = (result.Items ?? [])
    .map((item) => z.string().parse(unmarshall(item).guildId))
    .filter((key) => /^\d{17,20}$/.test(key));
  return {
    guildIds,
    cursor: result.LastEvaluatedKey
      ? z.string().parse(unmarshall(result.LastEvaluatedKey).guildId)
      : undefined,
  };
}
export function controlTableNames() {
  return {
    deploymentControl: tableName("DeploymentControlTable"),
    meetingHistory: tableName("MeetingHistoryTable"),
    activeMeeting: tableName("ActiveMeetingTable"),
    personalMediaUpload: tableName("PersonalMediaUploadJobTable"),
  };
}
export function getDeploymentControlRepository() {
  return bindDeploymentControlRepository(dynamoDbClient, controlTableNames());
}
export function getMeetingUpdateDeliveryRepository() {
  return bindMeetingUpdateDeliveryRepository(
    dynamoDbClient,
    controlTableNames(),
  );
}

export const createInitialMeetingHistory = (history: MeetingHistory) =>
  getDeploymentControlRepository().createInitialMeetingHistory(history);
export const transitionMeetingHistory = (input: HistoryTransition) =>
  getDeploymentControlRepository().transitionMeetingHistory(input);
const isConditionalCheckFailed = (error: unknown) =>
  (error as { name?: string }).name === "ConditionalCheckFailedException";

// Guild Subscription Table
export async function writeGuildSubscription(
  subscription: GuildSubscription,
): Promise<void> {
  const params = {
    TableName: tableName("GuildSubscriptionTable"),
    Item: marshall(subscription, { removeUndefinedValues: true }),
  };
  const command = new PutItemCommand(params);
  await dynamoDbClient.send(command);
}

export async function getGuildSubscription(
  guildId: string,
): Promise<GuildSubscription | undefined> {
  const params = {
    TableName: tableName("GuildSubscriptionTable"),
    Key: marshall({ guildId }),
    ConsistentRead: true,
  };
  const command = new GetItemCommand(params);
  const result = await dynamoDbClient.send(command);
  if (result.Item) {
    return unmarshall(result.Item) as GuildSubscription;
  }
  return undefined;
}

export async function compareAndWriteGuildSubscription(
  subscription: GuildSubscription,
  expected: GuildSubscription | undefined,
): Promise<boolean> {
  const names: Record<string, string> = { "#guildId": "guildId" };
  const values: Record<string, string> = {};
  const conditions = [
    expected ? "attribute_exists(#guildId)" : "attribute_not_exists(#guildId)",
  ];
  if (expected) {
    for (const key of ["stripeSubscriptionId", "stripeSyncRevision"] as const) {
      names[`#${key}`] = key;
      if (expected[key] !== undefined) {
        values[`:${key}`] = expected[key];
        conditions.push(`#${key} = :${key}`);
      } else {
        conditions.push(`attribute_not_exists(#${key})`);
      }
    }
  }
  try {
    await dynamoDbClient.send(
      new PutItemCommand({
        TableName: tableName("GuildSubscriptionTable"),
        Item: marshall(subscription, { removeUndefinedValues: true }),
        ConditionExpression: conditions.join(" AND "),
        ExpressionAttributeNames: names,
        ...(Object.keys(values).length
          ? { ExpressionAttributeValues: marshall(values) }
          : {}),
      }),
    );
    return true;
  } catch (error) {
    if (isConditionalCheckFailed(error)) return false;
    throw error;
  }
}

// Entitlement Grant Table
export async function writeEntitlementGrant(
  grant: EntitlementGrant,
): Promise<void> {
  const params = {
    TableName: tableName("EntitlementGrantTable"),
    Item: marshall(grant, { removeUndefinedValues: true }),
  };
  const command = new PutItemCommand(params);
  await dynamoDbClient.send(command);
}

export async function getEntitlementGrant(
  grantId: string,
): Promise<EntitlementGrant | undefined> {
  const params = {
    TableName: tableName("EntitlementGrantTable"),
    Key: marshall({ grantId }),
  };
  const command = new GetItemCommand(params);
  const result = await dynamoDbClient.send(command);
  if (result.Item) {
    return unmarshall(result.Item) as EntitlementGrant;
  }
  return undefined;
}

export async function listEntitlementGrants(params?: {
  guildId?: string;
  status?: EntitlementGrantStatus;
  limit?: number;
}): Promise<EntitlementGrant[]> {
  return params?.guildId
    ? queryEntitlementGrantsByGuild({ ...params, guildId: params.guildId })
    : scanEntitlementGrants(params);
}

function applyEntitlementGrantLimit(
  items: EntitlementGrant[],
  limit?: number,
): EntitlementGrant[] {
  return limit ? items.slice(0, limit) : items;
}

function remainingEntitlementGrantLimit(
  items: EntitlementGrant[],
  limit?: number,
): number | undefined {
  return limit ? limit - items.length : undefined;
}

function unmarshallEntitlementGrantItems(
  items?: Record<string, AttributeValue>[],
): EntitlementGrant[] {
  return (items ?? []).map((item) => unmarshall(item) as EntitlementGrant);
}

async function queryEntitlementGrantsByGuild(params: {
  guildId: string;
  status?: EntitlementGrantStatus;
  limit?: number;
}): Promise<EntitlementGrant[]> {
  const items: EntitlementGrant[] = [];
  const expressionAttributeNames: Record<string, string> = {
    "#guildId": "guildId",
  };
  const expressionAttributeValues: Record<string, AttributeValue> = marshall({
    ":guildId": params.guildId,
    ...(params.status ? { ":status": params.status } : {}),
  });
  let exclusiveStartKey: Record<string, AttributeValue> | undefined;
  do {
    const command = new QueryCommand({
      TableName: tableName("EntitlementGrantTable"),
      IndexName: "GuildIdIndex",
      KeyConditionExpression: "#guildId = :guildId",
      ...(params.status
        ? {
            FilterExpression: "#status = :status",
            ExpressionAttributeNames: {
              ...expressionAttributeNames,
              "#status": "status",
            },
          }
        : { ExpressionAttributeNames: expressionAttributeNames }),
      ExpressionAttributeValues: expressionAttributeValues,
      ExclusiveStartKey: exclusiveStartKey,
      Limit: remainingEntitlementGrantLimit(items, params.limit),
    });
    const result = await dynamoDbClient.send(command);
    items.push(...unmarshallEntitlementGrantItems(result.Items));
    exclusiveStartKey = result.LastEvaluatedKey;
  } while (
    exclusiveStartKey &&
    remainingEntitlementGrantLimit(items, params.limit)
  );
  return applyEntitlementGrantLimit(items, params.limit);
}

async function scanEntitlementGrants(params?: {
  status?: EntitlementGrantStatus;
  limit?: number;
}): Promise<EntitlementGrant[]> {
  const items: EntitlementGrant[] = [];
  const expressionAttributeNames: Record<string, string> = {};
  let expressionAttributeValues: Record<string, AttributeValue> | undefined;
  let filterExpression: string | undefined;
  if (params?.status) {
    expressionAttributeNames["#status"] = "status";
    expressionAttributeValues = marshall({ ":status": params.status });
    filterExpression = "#status = :status";
  }
  let exclusiveStartKey: Record<string, AttributeValue> | undefined;
  do {
    const command = new ScanCommand({
      TableName: tableName("EntitlementGrantTable"),
      FilterExpression: filterExpression,
      ExpressionAttributeNames: Object.keys(expressionAttributeNames).length
        ? expressionAttributeNames
        : undefined,
      ExpressionAttributeValues: expressionAttributeValues,
      ExclusiveStartKey: exclusiveStartKey,
      Limit: remainingEntitlementGrantLimit(items, params?.limit),
    });
    const result = await dynamoDbClient.send(command);
    items.push(...unmarshallEntitlementGrantItems(result.Items));
    exclusiveStartKey = result.LastEvaluatedKey;
  } while (
    exclusiveStartKey &&
    remainingEntitlementGrantLimit(items, params?.limit)
  );
  return applyEntitlementGrantLimit(items, params?.limit);
}

export async function listActiveEntitlementGrantsForGuild(
  guildId: string,
): Promise<EntitlementGrant[]> {
  return listEntitlementGrants({ guildId, status: "active" });
}

export async function revokeEntitlementGrant(params: {
  grantId: string;
  revokedAt: string;
  revokedBy: string;
  revocationReason: string;
  autoRevokedByStripeSubscriptionId?: string;
}): Promise<void> {
  const expressionAttributeNames: Record<string, string> = {
    "#status": "status",
    "#updatedAt": "updatedAt",
    "#updatedBy": "updatedBy",
    "#revokedAt": "revokedAt",
    "#revokedBy": "revokedBy",
    "#revocationReason": "revocationReason",
  };
  const values = {
    ":status": "revoked",
    ":activeStatus": "active",
    ":updatedAt": params.revokedAt,
    ":updatedBy": params.revokedBy,
    ":revokedAt": params.revokedAt,
    ":revokedBy": params.revokedBy,
    ":revocationReason": params.revocationReason,
    ...(params.autoRevokedByStripeSubscriptionId
      ? {
          ":autoRevokedByStripeSubscriptionId":
            params.autoRevokedByStripeSubscriptionId,
        }
      : {}),
  };
  let updateExpression =
    "SET #status = :status, #updatedAt = :updatedAt, #updatedBy = :updatedBy, #revokedAt = :revokedAt, #revokedBy = :revokedBy, #revocationReason = :revocationReason";
  if (params.autoRevokedByStripeSubscriptionId) {
    expressionAttributeNames["#autoRevokedByStripeSubscriptionId"] =
      "autoRevokedByStripeSubscriptionId";
    updateExpression +=
      ", #autoRevokedByStripeSubscriptionId = :autoRevokedByStripeSubscriptionId";
  }
  const command = new UpdateItemCommand({
    TableName: tableName("EntitlementGrantTable"),
    Key: marshall({ grantId: params.grantId }),
    UpdateExpression: updateExpression,
    ConditionExpression:
      "attribute_exists(grantId) AND #status = :activeStatus",
    ExpressionAttributeNames: expressionAttributeNames,
    ExpressionAttributeValues: marshall(values, {
      removeUndefinedValues: true,
    }),
  });
  try {
    await dynamoDbClient.send(command);
  } catch (error) {
    if (isConditionalCheckFailed(error)) return;
    throw error;
  }
}

// Write to PaymentTransaction Table
export async function writePaymentTransaction(
  transaction: PaymentTransaction,
): Promise<void> {
  const params = {
    TableName: tableName("PaymentTransactionTable"),
    Item: marshall(
      { ...transaction, TransactionID: transaction.transactionID },
      { removeUndefinedValues: true },
    ),
  };
  const command = new PutItemCommand(params);
  await dynamoDbClient.send(command);
}

// Stripe Webhook Event Table (idempotency)
export async function tryCreateStripeWebhookEvent(
  event: StripeWebhookEvent,
): Promise<boolean> {
  const params = {
    TableName: tableName("StripeWebhookEventTable"),
    Item: marshall(event, { removeUndefinedValues: true }),
    ConditionExpression: "attribute_not_exists(eventId)",
  };
  const command = new PutItemCommand(params);
  try {
    await dynamoDbClient.send(command);
    return true;
  } catch (error) {
    if (isConditionalCheckFailed(error)) return false;
    throw error;
  }
}

export async function deleteStripeWebhookEvent(eventId: string): Promise<void> {
  const params = {
    TableName: tableName("StripeWebhookEventTable"),
    Key: marshall({ eventId }),
  };
  const command = new DeleteItemCommand(params);
  await dynamoDbClient.send(command);
}

export async function getStripeWebhookEvent(
  eventId: string,
): Promise<StripeWebhookEvent | undefined> {
  const params = {
    TableName: tableName("StripeWebhookEventTable"),
    Key: marshall({ eventId }),
  };
  const command = new GetItemCommand(params);
  const result = await dynamoDbClient.send(command);
  if (result.Item) {
    return unmarshall(result.Item) as StripeWebhookEvent;
  }
  return undefined;
}

export async function getInteractionReceipt(
  interactionId: string,
): Promise<InteractionReceipt | undefined> {
  const result = await dynamoDbClient.send(
    new GetItemCommand({
      TableName: tableName("InteractionReceiptTable"),
      Key: marshall({ interactionId }),
    }),
  );
  return result.Item
    ? (unmarshall(result.Item) as InteractionReceipt)
    : undefined;
}

const runtimeInteractionReceipts = new Map<string, InteractionReceipt>();
export async function tryCreateInteractionReceipt(
  receipt: InteractionReceipt,
  replaceExpiredBefore?: number,
  authority?: WorkAdmissionAuthority,
): Promise<boolean> {
  const params = {
    TableName: tableName("InteractionReceiptTable"),
    Item: marshall(receipt, { removeUndefinedValues: true }),
    ConditionExpression:
      replaceExpiredBefore === undefined
        ? "attribute_not_exists(interactionId)"
        : "attribute_not_exists(interactionId) OR expiresAt <= :now",
    ...(replaceExpiredBefore === undefined
      ? {}
      : {
          ExpressionAttributeValues: marshall({ ":now": replaceExpiredBefore }),
        }),
  };
  if (authority && config.mock.enabled) {
    const store = getMockStore();
    if (
      !mockWorkAdmissionAllowed(
        authority,
        store.deploymentControlRecords,
        store.activeMeetingLeases,
      )
    )
      return false;
    if (runtimeInteractionReceipts.has(receipt.interactionId)) return false;
    runtimeInteractionReceipts.set(receipt.interactionId, receipt);
    return true;
  }
  const transaction = authority
    ? new TransactWriteItemsCommand({
        TransactItems: [
          ...buildWorkAdmissionChecks(authority, {
            deploymentControl: tableName("DeploymentControlTable"),
            meetingHistory: tableName("MeetingHistoryTable"),
            activeMeeting: tableName("ActiveMeetingTable"),
          }),
          { Put: params },
        ],
      })
    : undefined;
  try {
    if (transaction) await dynamoDbClient.send(transaction);
    else await dynamoDbClient.send(new PutItemCommand(params));
    return true;
  } catch (error) {
    if (classifyDeploymentTransactionError(error) === "stale") {
      return false;
    }
    throw error;
  }
}

export async function releaseInteractionReceipt(
  receipt: InteractionReceipt,
): Promise<boolean> {
  try {
    await dynamoDbClient.send(
      new DeleteItemCommand({
        TableName: tableName("InteractionReceiptTable"),
        Key: marshall({ interactionId: receipt.interactionId }),
        ConditionExpression:
          "createdAt = :createdAt AND expiresAt = :expiresAt",
        ExpressionAttributeValues: marshall({
          ":createdAt": receipt.createdAt,
          ":expiresAt": receipt.expiresAt,
        }),
      }),
    );
    return true;
  } catch (error) {
    if (isConditionalCheckFailed(error)) return false;
    throw error;
  }
}

export async function tryAcquireActiveMeetingLease(
  lease: ActiveMeetingLease,
  nowEpochSeconds: number,
): Promise<boolean> {
  const sameOwnerSameMeetingCondition =
    "#ownerInstanceId = :ownerInstanceId AND #meetingId = :meetingId";
  const params = {
    TableName: tableName("ActiveMeetingTable"),
    Item: marshall(lease, { removeUndefinedValues: true }),
    ConditionExpression: `attribute_not_exists(#guildId) OR #leaseExpiresAt < :now OR (${sameOwnerSameMeetingCondition})`,
    ExpressionAttributeNames: {
      "#guildId": "guildId",
      "#leaseExpiresAt": "leaseExpiresAt",
      "#ownerInstanceId": "ownerInstanceId",
      "#meetingId": "meetingId",
    },
    ExpressionAttributeValues: marshall({
      ":now": nowEpochSeconds,
      ":ownerInstanceId": lease.ownerInstanceId,
      ":meetingId": lease.meetingId,
    }),
  };
  const command = new PutItemCommand(params);
  try {
    await dynamoDbClient.send(command);
    return true;
  } catch (error) {
    if (
      (error as { name?: string }).name === "ConditionalCheckFailedException"
    ) {
      return false;
    }
    throw error;
  }
}

export async function renewActiveMeetingLease(
  guildId: string,
  meetingId: string,
  ownerInstanceId: string,
  leaseExpiresAt: number,
  updatedAt: string,
  expiresAt: number,
  snapshot: {
    status: ActiveMeetingLease["status"];
    endReason?: ActiveMeetingLease["endReason"];
    endTriggeredByUserId?: ActiveMeetingLease["endTriggeredByUserId"];
    cancellationReason?: ActiveMeetingLease["cancellationReason"];
    endedAt?: ActiveMeetingLease["endedAt"];
  },
  ownership?: { executionVersion: number; sessionMode: "meeting" | "tts_only" },
): Promise<boolean> {
  const now = Math.floor(Date.now() / 1000);
  if (config.mock.enabled) {
    const lease = getMockStore().activeMeetingLeases.get(guildId);
    if (
      !lease ||
      lease.leaseExpiresAt < now ||
      lease.meetingId !== meetingId ||
      lease.ownerInstanceId !== ownerInstanceId ||
      lease.executionVersion !== ownership?.executionVersion ||
      lease.sessionMode !== ownership?.sessionMode
    )
      return false;
    Object.assign(lease, { leaseExpiresAt, updatedAt, expiresAt, ...snapshot });
    return true;
  }
  const updateParts = [
    "#leaseExpiresAt = :leaseExpiresAt",
    "#updatedAt = :updatedAt",
    "#expiresAt = :expiresAt",
    "#status = :status",
  ];
  const expressionAttributeNames: Record<string, string> = {
    "#leaseExpiresAt": "leaseExpiresAt",
    "#updatedAt": "updatedAt",
    "#expiresAt": "expiresAt",
    "#status": "status",
    "#meetingId": "meetingId",
    "#ownerInstanceId": "ownerInstanceId",
    "#executionVersion": "executionVersion",
  };
  const expressionAttributeValues: Record<string, unknown> = {
    ":leaseExpiresAt": leaseExpiresAt,
    ":updatedAt": updatedAt,
    ":expiresAt": expiresAt,
    ":status": snapshot.status,
    ":now": now,
    ":meetingId": meetingId,
    ":ownerInstanceId": ownerInstanceId,
  };

  if (snapshot.endReason) {
    updateParts.push("#endReason = :endReason");
    expressionAttributeNames["#endReason"] = "endReason";
    expressionAttributeValues[":endReason"] = snapshot.endReason;
  }

  if (snapshot.endTriggeredByUserId) {
    updateParts.push("#endTriggeredByUserId = :endTriggeredByUserId");
    expressionAttributeNames["#endTriggeredByUserId"] = "endTriggeredByUserId";
    expressionAttributeValues[":endTriggeredByUserId"] =
      snapshot.endTriggeredByUserId;
  }

  if (snapshot.cancellationReason) {
    updateParts.push("#cancellationReason = :cancellationReason");
    expressionAttributeNames["#cancellationReason"] = "cancellationReason";
    expressionAttributeValues[":cancellationReason"] =
      snapshot.cancellationReason;
  }

  if (snapshot.endedAt) {
    updateParts.push("#endedAt = :endedAt");
    expressionAttributeNames["#endedAt"] = "endedAt";
    expressionAttributeValues[":endedAt"] = snapshot.endedAt;
  }

  const params: UpdateItemCommand["input"] = {
    TableName: tableName("ActiveMeetingTable"),
    Key: marshall({ guildId }),
    UpdateExpression: `SET ${updateParts.join(", ")}`,
    ConditionExpression:
      "#leaseExpiresAt >= :now AND #meetingId = :meetingId AND #ownerInstanceId = :ownerInstanceId AND " +
      (ownership
        ? "#executionVersion = :executionVersion AND sessionMode = :sessionMode"
        : "attribute_not_exists(#executionVersion)"),
    ExpressionAttributeNames: expressionAttributeNames,
    ExpressionAttributeValues: marshall(
      {
        ...expressionAttributeValues,
        ...(ownership
          ? {
              ":executionVersion": ownership.executionVersion,
              ":sessionMode": ownership.sessionMode,
            }
          : {}),
      },
      {
        removeUndefinedValues: true,
      },
    ),
  };
  const command = new UpdateItemCommand(params);
  try {
    await dynamoDbClient.send(command);
    return true;
  } catch (error) {
    if (
      (error as { name?: string }).name === "ConditionalCheckFailedException"
    ) {
      return false;
    }
    throw error;
  }
}

export async function releaseActiveMeetingLease(
  guildId: string,
  meetingId: string,
  ownerInstanceId: string,
  ownership?: {
    executionVersion: number;
    sessionMode: "meeting" | "tts_only";
    voiceOperationAttemptId?: string;
  },
  signal?: AbortSignal,
): Promise<boolean> {
  signal?.throwIfAborted();
  if (config.mock.enabled) {
    const lease = getMockStore().activeMeetingLeases.get(guildId);
    if (
      !lease ||
      lease.meetingId !== meetingId ||
      lease.ownerInstanceId !== ownerInstanceId ||
      lease.executionVersion !== ownership?.executionVersion ||
      lease.sessionMode !== ownership?.sessionMode ||
      (ownership?.voiceOperationAttemptId !== undefined &&
        lease.voiceOperationAttemptId !== ownership.voiceOperationAttemptId)
    )
      return false;
    return getMockStore().activeMeetingLeases.delete(guildId);
  }
  const params: DeleteItemCommand["input"] = {
    TableName: tableName("ActiveMeetingTable"),
    Key: marshall({ guildId }),
    ConditionExpression:
      "#meetingId = :meetingId AND #ownerInstanceId = :ownerInstanceId AND " +
      (ownership
        ? "#executionVersion = :executionVersion AND sessionMode = :sessionMode"
        : "attribute_not_exists(#executionVersion)") +
      (ownership?.voiceOperationAttemptId
        ? " AND voiceOperationAttemptId = :voiceAttempt"
        : ""),
    ExpressionAttributeNames: {
      "#meetingId": "meetingId",
      "#ownerInstanceId": "ownerInstanceId",
      "#executionVersion": "executionVersion",
    },
    ExpressionAttributeValues: marshall({
      ":meetingId": meetingId,
      ":ownerInstanceId": ownerInstanceId,
      ...(ownership?.voiceOperationAttemptId
        ? { ":voiceAttempt": ownership.voiceOperationAttemptId }
        : {}),
      ...(ownership
        ? {
            ":executionVersion": ownership.executionVersion,
            ":sessionMode": ownership.sessionMode,
          }
        : {}),
    }),
  };
  const command = new DeleteItemCommand(params);
  try {
    await dynamoDbClient.send(command, { abortSignal: signal });
    return true;
  } catch (error) {
    if (
      (error as { name?: string }).name === "ConditionalCheckFailedException"
    ) {
      return false;
    }
    throw error;
  }
}

export async function getActiveMeetingLease(
  guildId: string,
  signal?: AbortSignal,
): Promise<ActiveMeetingLease | undefined> {
  signal?.throwIfAborted();
  if (config.mock.enabled)
    return getMockStore().activeMeetingLeases.get(guildId);
  const params: GetItemCommand["input"] = {
    TableName: tableName("ActiveMeetingTable"),
    Key: marshall({ guildId }),
    ConsistentRead: true,
  };
  const command = new GetItemCommand(params);
  const result = await dynamoDbClient.send(command, { abortSignal: signal });
  if (result.Item) {
    return unmarshall(result.Item) as ActiveMeetingLease;
  }
  return undefined;
}

export async function requestActiveMeetingEnd(
  guildId: string,
  meetingId: string,
  requestedByUserId: string,
  requestedAt: string,
  endReason?: ActiveMeetingLease["endReason"],
): Promise<boolean> {
  const updateParts = [
    "#endRequestedAt = if_not_exists(#endRequestedAt, :endRequestedAt)",
    "#endRequestedByUserId = if_not_exists(#endRequestedByUserId, :endRequestedByUserId)",
    "#updatedAt = :updatedAt",
  ];
  const expressionAttributeNames: Record<string, string> = {
    "#endRequestedAt": "endRequestedAt",
    "#endRequestedByUserId": "endRequestedByUserId",
    "#updatedAt": "updatedAt",
    "#meetingId": "meetingId",
  };
  const expressionAttributeValues: Record<string, unknown> = {
    ":endRequestedAt": requestedAt,
    ":endRequestedByUserId": requestedByUserId,
    ":updatedAt": requestedAt,
    ":meetingId": meetingId,
  };
  if (endReason) {
    updateParts.push("#endReason = if_not_exists(#endReason, :endReason)");
    expressionAttributeNames["#endReason"] = "endReason";
    expressionAttributeValues[":endReason"] = endReason;
  }
  const params: UpdateItemCommand["input"] = {
    TableName: tableName("ActiveMeetingTable"),
    Key: marshall({ guildId }),
    UpdateExpression: `SET ${updateParts.join(", ")}`,
    ConditionExpression:
      "#meetingId = :meetingId AND (attribute_not_exists(#endRequestedAt) OR #endRequestedByUserId = :endRequestedByUserId)",
    ExpressionAttributeNames: expressionAttributeNames,
    ExpressionAttributeValues: marshall(expressionAttributeValues, {
      removeUndefinedValues: true,
    }),
  };
  const command = new UpdateItemCommand(params);
  try {
    await dynamoDbClient.send(command);
    return true;
  } catch (error) {
    if (
      (error as { name?: string }).name === "ConditionalCheckFailedException"
    ) {
      return false;
    }
    throw error;
  }
}

// Read from PaymentTransaction Table
export async function getPaymentTransaction(
  transactionID: string,
): Promise<PaymentTransaction | undefined> {
  const params = {
    TableName: tableName("PaymentTransactionTable"),
    Key: marshall({ TransactionID: transactionID }),
  };
  const command = new GetItemCommand(params);
  const result = await dynamoDbClient.send(command);
  if (result.Item) {
    return unmarshall(result.Item) as PaymentTransaction;
  }
  return undefined;
}

// Write to AccessLog Table
export async function writeAccessLog(accessLog: AccessLog): Promise<void> {
  const params = {
    TableName: tableName("AccessLogsTable"),
    Item: marshall(accessLog),
  };
  const command = new PutItemCommand(params);
  await dynamoDbClient.send(command);
}

// Read from AccessLog Table
export async function getAccessLog(
  accessLogID: string,
): Promise<AccessLog | undefined> {
  const params = {
    TableName: tableName("AccessLogsTable"),
    Key: marshall({ AccessLogID: accessLogID }),
  };
  const command = new GetItemCommand(params);
  const result = await dynamoDbClient.send(command);
  if (result.Item) {
    return unmarshall(result.Item) as AccessLog;
  }
  return undefined;
}

// Write to RecordingTranscript Table
export async function writeRecordingTranscript(
  recordingTranscript: RecordingTranscript,
): Promise<void> {
  const params = {
    TableName: tableName("RecordingTranscriptTable"),
    Item: marshall(recordingTranscript),
  };
  const command = new PutItemCommand(params);
  await dynamoDbClient.send(command);
}

// Read from RecordingTranscript Table
export async function getRecordingTranscript(
  meetingID: string,
): Promise<RecordingTranscript | undefined> {
  const params = {
    TableName: tableName("RecordingTranscriptTable"),
    Key: marshall({ MeetingID: meetingID }),
  };
  const command = new GetItemCommand(params);
  const result = await dynamoDbClient.send(command);
  if (result.Item) {
    return unmarshall(result.Item) as RecordingTranscript;
  }
  return undefined;
}

// Write AutoRecordSettings
export async function writeAutoRecordSetting(
  setting: AutoRecordSettings,
): Promise<void> {
  const params = {
    TableName: tableName("AutoRecordSettingsTable"),
    Item: marshall(setting, { removeUndefinedValues: true }),
  };
  const command = new PutItemCommand(params);
  await dynamoDbClient.send(command);
}

// Get specific AutoRecordSetting
export async function getAutoRecordSetting(
  guildId: string,
  channelId: string,
): Promise<AutoRecordSettings | undefined> {
  const params = {
    TableName: tableName("AutoRecordSettingsTable"),
    Key: marshall({ guildId, channelId }),
  };
  const command = new GetItemCommand(params);
  const result = await dynamoDbClient.send(command);
  if (result.Item) {
    return unmarshall(result.Item) as AutoRecordSettings;
  }
  return undefined;
}

// Get all AutoRecordSettings for a guild
export async function getAllAutoRecordSettings(
  guildId: string,
): Promise<AutoRecordSettings[]> {
  const params = {
    TableName: tableName("AutoRecordSettingsTable"),
    KeyConditionExpression: "guildId = :guildId",
    ExpressionAttributeValues: marshall({
      ":guildId": guildId,
    }),
  };
  const command = new QueryCommand(params);
  const result = await dynamoDbClient.send(command);
  if (result.Items) {
    return result.Items.map((item) => unmarshall(item) as AutoRecordSettings);
  }
  return [];
}

export async function scanAutoRecordSettings(): Promise<AutoRecordSettings[]> {
  const items: AutoRecordSettings[] = [];
  let lastKey: Record<string, AttributeValue> | undefined;

  do {
    const params = {
      TableName: tableName("AutoRecordSettingsTable"),
      ExclusiveStartKey: lastKey,
    };
    const command = new ScanCommand(params);
    const result = await dynamoDbClient.send(command);
    if (result.Items) {
      items.push(
        ...result.Items.map((item) => unmarshall(item) as AutoRecordSettings),
      );
    }
    lastKey = result.LastEvaluatedKey;
  } while (lastKey);

  return items;
}

// Delete AutoRecordSetting
export async function deleteAutoRecordSetting(
  guildId: string,
  channelId: string,
): Promise<void> {
  const params = {
    TableName: tableName("AutoRecordSettingsTable"),
    Key: marshall({ guildId, channelId }),
  };
  const command = new DeleteItemCommand(params);
  await dynamoDbClient.send(command);
}

// Scan for all guilds with recordAll enabled
export async function scanAutoRecordSettingsForRecordAll(): Promise<
  AutoRecordSettings[]
> {
  const params = {
    TableName: tableName("AutoRecordSettingsTable"),
    FilterExpression: "recordAll = :recordAll AND enabled = :enabled",
    ExpressionAttributeValues: marshall({
      ":recordAll": true,
      ":enabled": true,
    }),
  };
  const command = new ScanCommand(params);
  const result = await dynamoDbClient.send(command);
  if (result.Items) {
    return result.Items.map((item) => unmarshall(item) as AutoRecordSettings);
  }
  return [];
}

// Server Context operations
export async function writeServerContext(
  context: ServerContext,
): Promise<void> {
  const params = {
    TableName: tableName("ServerContextTable"),
    Item: marshall(context, { removeUndefinedValues: true }),
  };
  const command = new PutItemCommand(params);
  await dynamoDbClient.send(command);
}

export async function getServerContext(
  guildId: string,
): Promise<ServerContext | undefined> {
  const params = {
    TableName: tableName("ServerContextTable"),
    Key: marshall({ guildId }),
  };
  const command = new GetItemCommand(params);
  const result = await dynamoDbClient.send(command);
  if (result.Item) {
    return unmarshall(result.Item) as ServerContext;
  }
  return undefined;
}

export async function deleteServerContext(guildId: string): Promise<void> {
  const params = {
    TableName: tableName("ServerContextTable"),
    Key: marshall({ guildId }),
  };
  const command = new DeleteItemCommand(params);
  await dynamoDbClient.send(command);
}

// Channel Context operations
export async function writeChannelContext(
  context: ChannelContext,
): Promise<void> {
  const params = {
    TableName: tableName("ChannelContextTable"),
    Item: marshall(context, { removeUndefinedValues: true }),
  };
  const command = new PutItemCommand(params);
  await dynamoDbClient.send(command);
}

export async function getChannelContext(
  guildId: string,
  channelId: string,
): Promise<ChannelContext | undefined> {
  const params = {
    TableName: tableName("ChannelContextTable"),
    Key: marshall({ guildId, channelId }),
  };
  const command = new GetItemCommand(params);
  const result = await dynamoDbClient.send(command);
  if (result.Item) {
    return unmarshall(result.Item) as ChannelContext;
  }
  return undefined;
}

// User Speech Settings
export async function writeUserSpeechSettings(
  settings: UserSpeechSettings,
): Promise<void> {
  const params = {
    TableName: tableName("UserSpeechSettingsTable"),
    Item: marshall(settings, { removeUndefinedValues: true }),
  };
  const command = new PutItemCommand(params);
  await dynamoDbClient.send(command);
}

export async function getUserSpeechSettings(
  guildId: string,
  userId: string,
): Promise<UserSpeechSettings | undefined> {
  const params = {
    TableName: tableName("UserSpeechSettingsTable"),
    Key: marshall({ guildId, userId }),
  };
  const command = new GetItemCommand(params);
  const result = await dynamoDbClient.send(command);
  if (result.Item) {
    return unmarshall(result.Item) as UserSpeechSettings;
  }
  return undefined;
}

export async function deleteUserSpeechSettings(
  guildId: string,
  userId: string,
): Promise<void> {
  const params = {
    TableName: tableName("UserSpeechSettingsTable"),
    Key: marshall({ guildId, userId }),
  };
  const command = new DeleteItemCommand(params);
  await dynamoDbClient.send(command);
}

// Chat TTS Monthly Usage
export async function getChatTtsMonthlyUsage(
  guildId: string,
  period: string,
): Promise<ChatTtsMonthlyUsage | undefined> {
  const params = {
    TableName: tableName("ChatTtsUsageTable"),
    Key: marshall({ guildId, period }),
    ConsistentRead: true,
  };
  const command = new GetItemCommand(params);
  const result = await dynamoDbClient.send(command);
  if (result.Item) {
    return unmarshall(result.Item) as ChatTtsMonthlyUsage;
  }
  return undefined;
}

export async function tryReserveChatTtsMonthlyUsage(
  usage: ChatTtsMonthlyUsage,
  maxMessages: number,
): Promise<ChatTtsMonthlyUsage | undefined> {
  const params: UpdateItemCommand["input"] = {
    TableName: tableName("ChatTtsUsageTable"),
    Key: marshall({ guildId: usage.guildId, period: usage.period }),
    UpdateExpression:
      "SET #createdAt = if_not_exists(#createdAt, :createdAt), #updatedAt = :updatedAt, #expiresAt = :expiresAt ADD #acceptedMessages :one",
    ConditionExpression:
      "attribute_not_exists(#acceptedMessages) OR #acceptedMessages < :maxMessages",
    ExpressionAttributeNames: {
      "#acceptedMessages": "acceptedMessages",
      "#createdAt": "createdAt",
      "#updatedAt": "updatedAt",
      "#expiresAt": "expiresAt",
    },
    ExpressionAttributeValues: marshall({
      ":createdAt": usage.createdAt,
      ":updatedAt": usage.updatedAt,
      ":expiresAt": usage.expiresAt,
      ":one": 1,
      ":maxMessages": maxMessages,
    }),
    ReturnValues: "ALL_NEW",
  };
  const command = new UpdateItemCommand(params);
  try {
    const result = await dynamoDbClient.send(command);
    return result.Attributes
      ? (unmarshall(result.Attributes) as ChatTtsMonthlyUsage)
      : undefined;
  } catch (error) {
    if (isConditionalCheckFailed(error)) {
      return undefined;
    }
    throw error;
  }
}

export async function releaseChatTtsMonthlyUsageReservation(
  guildId: string,
  period: string,
  updatedAt: string,
): Promise<void> {
  const params: UpdateItemCommand["input"] = {
    TableName: tableName("ChatTtsUsageTable"),
    Key: marshall({ guildId, period }),
    UpdateExpression:
      "SET #updatedAt = :updatedAt ADD #acceptedMessages :minusOne",
    ConditionExpression: "#acceptedMessages >= :one",
    ExpressionAttributeNames: {
      "#acceptedMessages": "acceptedMessages",
      "#updatedAt": "updatedAt",
    },
    ExpressionAttributeValues: marshall({
      ":updatedAt": updatedAt,
      ":minusOne": -1,
      ":one": 1,
    }),
  };
  const command = new UpdateItemCommand(params);
  try {
    await dynamoDbClient.send(command);
  } catch (error) {
    if (isConditionalCheckFailed(error)) {
      return;
    }
    throw error;
  }
}

// Immutable ephemeral browse snapshots use their own namespace, never login sessions.
const mockMeetingBrowseStates = new Map<
  string,
  { payload: unknown; expiresAt: number }
>();
export async function putMeetingBrowseCursorState(
  id: string,
  payload: unknown,
  expiresAt: number,
): Promise<void> {
  const sid = `MEETING_BROWSE_CURSOR#${id}`;
  if (config.mock.enabled) {
    if (mockMeetingBrowseStates.has(sid))
      throw new Error("Browse snapshot already exists");
    const now = Date.now();
    for (const [key, state] of mockMeetingBrowseStates)
      if (state.expiresAt <= now) mockMeetingBrowseStates.delete(key);
    mockMeetingBrowseStates.set(sid, {
      payload: structuredClone(payload),
      expiresAt,
    });
    return;
  }
  await dynamoDbClient.send(
    new PutItemCommand({
      TableName: tableName("SessionTable"),
      Item: marshall(
        { sid, payload, expiresAt: Math.ceil(expiresAt / 1000) },
        { removeUndefinedValues: true },
      ),
      ConditionExpression: "attribute_not_exists(sid)",
    }),
  );
}
export async function getMeetingBrowseCursorState(
  id: string,
  now = Date.now(),
): Promise<unknown> {
  const sid = `MEETING_BROWSE_CURSOR#${id}`;
  if (config.mock.enabled) {
    const state = mockMeetingBrowseStates.get(sid);
    return state && state.expiresAt > now
      ? structuredClone(state.payload)
      : undefined;
  }
  const result = await dynamoDbClient.send(
    new GetItemCommand({
      TableName: tableName("SessionTable"),
      Key: marshall({ sid }),
      ConsistentRead: true,
    }),
  );
  if (!result.Item) return undefined;
  const row = unmarshall(result.Item);
  return typeof row.expiresAt === "number" && row.expiresAt * 1000 > now
    ? row.payload
    : undefined;
}

// Dictionary operations
const dictionaryRevisionSid = (guildId: string) =>
  `dictionaryRevision#${guildId}`;
const DICTIONARY_LOCK_TTL_SECONDS = 30;
const DICTIONARY_COMMIT_TTL_SECONDS = 300;
const DICTIONARY_LOCK_ATTEMPTS = 10;
const DICTIONARY_LOCK_RETRY_MS = 25;
const DICTIONARY_REVISION_RECONCILE_ATTEMPTS = 3;
const DICTIONARY_AMBIGUOUS_READ_ATTEMPTS = 3;

export async function acquireDictionaryLock(
  guildId: string,
): Promise<string | undefined> {
  const token = randomUUID();
  for (let attempt = 0; attempt < DICTIONARY_LOCK_ATTEMPTS; attempt += 1) {
    const now = Math.floor(Date.now() / 1000);
    const command = new UpdateItemCommand({
      TableName: tableName("SessionTable"),
      Key: marshall({ sid: dictionaryRevisionSid(guildId) }),
      UpdateExpression:
        "SET #lockToken = :lockToken, #lockExpiresAt = :lockExpiresAt",
      ConditionExpression:
        "attribute_not_exists(#lockToken) OR attribute_not_exists(#lockExpiresAt) OR #lockExpiresAt < :now",
      ExpressionAttributeNames: {
        "#lockToken": "lockToken",
        "#lockExpiresAt": "lockExpiresAt",
      },
      ExpressionAttributeValues: marshall({
        ":lockToken": token,
        ":lockExpiresAt": now + DICTIONARY_LOCK_TTL_SECONDS,
        ":now": now,
      }),
    });
    try {
      await dynamoDbClient.send(command);
      return token;
    } catch (error) {
      if (!isConditionalCheckFailed(error)) throw error;
      if (attempt + 1 < DICTIONARY_LOCK_ATTEMPTS) {
        await new Promise((resolve) =>
          setTimeout(resolve, DICTIONARY_LOCK_RETRY_MS),
        );
      }
    }
  }
  return undefined;
}

export async function releaseDictionaryLock(
  guildId: string,
  token: string,
): Promise<void> {
  const command = new UpdateItemCommand({
    TableName: tableName("SessionTable"),
    Key: marshall({ sid: dictionaryRevisionSid(guildId) }),
    UpdateExpression: "REMOVE #lockToken, #lockExpiresAt",
    ConditionExpression: "#lockToken = :lockToken",
    ExpressionAttributeNames: {
      "#lockToken": "lockToken",
      "#lockExpiresAt": "lockExpiresAt",
    },
    ExpressionAttributeValues: marshall({ ":lockToken": token }),
  });
  try {
    await dynamoDbClient.send(command);
  } catch (error) {
    if (!isConditionalCheckFailed(error)) {
      console.warn("Failed releasing dictionary lock; lease will expire", {
        guildId,
        error,
      });
    }
  }
}

export async function renewDictionaryLock(
  guildId: string,
  token: string,
  ttlSeconds = DICTIONARY_LOCK_TTL_SECONDS,
): Promise<boolean> {
  const now = Math.floor(Date.now() / 1000);
  const command = new UpdateItemCommand({
    TableName: tableName("SessionTable"),
    Key: marshall({ sid: dictionaryRevisionSid(guildId) }),
    UpdateExpression: "SET #lockExpiresAt = :lockExpiresAt",
    ConditionExpression: "#lockToken = :lockToken AND #lockExpiresAt >= :now",
    ExpressionAttributeNames: {
      "#lockToken": "lockToken",
      "#lockExpiresAt": "lockExpiresAt",
    },
    ExpressionAttributeValues: marshall({
      ":lockToken": token,
      ":lockExpiresAt": now + ttlSeconds,
      ":now": now,
    }),
  });
  try {
    await dynamoDbClient.send(command);
    return true;
  } catch (error) {
    if (isConditionalCheckFailed(error)) return false;
    throw error;
  }
}

export async function getDictionaryRevision(guildId: string): Promise<number> {
  const command = new GetItemCommand({
    TableName: tableName("SessionTable"),
    Key: marshall({ sid: dictionaryRevisionSid(guildId) }),
    ConsistentRead: true,
  });
  const result = await dynamoDbClient.send(command);
  if (!result.Item) return 0;
  const revision = unmarshall(result.Item).revision;
  return typeof revision === "number" ? revision : 0;
}

async function advanceDictionaryRevision(
  guildId: string,
  lockToken: string,
  currentRevision: number,
): Promise<boolean> {
  const now = Math.floor(Date.now() / 1000);
  const command = new UpdateItemCommand({
    TableName: tableName("SessionTable"),
    Key: marshall({ sid: dictionaryRevisionSid(guildId) }),
    UpdateExpression: "SET #revision = :nextRevision",
    ConditionExpression:
      "#lockToken = :lockToken AND #lockExpiresAt >= :now AND (attribute_not_exists(#revision) OR #revision = :currentRevision)",
    ExpressionAttributeNames: {
      "#lockToken": "lockToken",
      "#lockExpiresAt": "lockExpiresAt",
      "#revision": "revision",
    },
    ExpressionAttributeValues: marshall({
      ":lockToken": lockToken,
      ":now": now,
      ":currentRevision": currentRevision,
      ":nextRevision": currentRevision + 1,
    }),
  });
  try {
    await dynamoDbClient.send(command);
    return true;
  } catch (error) {
    if (!isConditionalCheckFailed(error)) throw error;
    return (await getDictionaryRevision(guildId)) === currentRevision + 1;
  }
}

async function reconcileDictionaryRevision(
  guildId: string,
  lockToken: string,
  currentRevision: number,
): Promise<boolean> {
  let lastError: unknown;
  for (
    let attempt = 0;
    attempt < DICTIONARY_REVISION_RECONCILE_ATTEMPTS;
    attempt += 1
  ) {
    try {
      if (
        await advanceDictionaryRevision(guildId, lockToken, currentRevision)
      ) {
        return true;
      }
    } catch (error) {
      lastError = error;
    }
    try {
      const observedRevision = await getDictionaryRevision(guildId);
      if (observedRevision === currentRevision + 1) return true;
      if (observedRevision !== currentRevision) return false;
      if (
        !(await renewDictionaryLock(
          guildId,
          lockToken,
          DICTIONARY_COMMIT_TTL_SECONDS,
        ))
      ) {
        return false;
      }
    } catch (error) {
      lastError = error;
    }
  }
  if (lastError) throw lastError;
  return false;
}

type DictionaryEntryReadback =
  { verified: true; entry?: DictionaryEntry } | { verified: false };
type DictionaryDeleteOutcome =
  { verified: true } | { verified: false; error: unknown };

async function readDictionaryEntryAfterAmbiguousMutation(
  guildId: string,
  termKey: string,
): Promise<DictionaryEntryReadback> {
  for (
    let attempt = 0;
    attempt < DICTIONARY_AMBIGUOUS_READ_ATTEMPTS;
    attempt += 1
  ) {
    try {
      return {
        verified: true,
        entry: await getDictionaryEntry(guildId, termKey),
      };
    } catch {
      // Each GetItem call already uses the SDK retry policy. A new call gives a
      // transiently failed read another independent chance while the lock holds.
    }
  }
  return { verified: false };
}

async function dictionaryEntryWasPersisted(
  entry: DictionaryEntry,
): Promise<boolean | undefined> {
  const readback = await readDictionaryEntryAfterAmbiguousMutation(
    entry.guildId,
    entry.termKey,
  );
  if (!readback.verified) return undefined;
  const normalizedEntry = unmarshall(
    marshall(entry, { removeUndefinedValues: true }),
  ) as DictionaryEntry;
  return isDeepStrictEqual(readback.entry, normalizedEntry);
}

async function deleteDictionaryEntryRecord(
  guildId: string,
  termKey: string,
): Promise<DictionaryDeleteOutcome> {
  try {
    await dynamoDbClient.send(
      new DeleteItemCommand({
        TableName: tableName("DictionaryTable"),
        Key: marshall({ guildId, termKey }),
      }),
    );
    return { verified: true };
  } catch (error) {
    const readback = await readDictionaryEntryAfterAmbiguousMutation(
      guildId,
      termKey,
    );
    if (!readback.verified) return { verified: false, error };
    if (readback.entry) throw error;
    return { verified: true };
  }
}

export async function writeDictionaryEntry(
  entry: DictionaryEntry,
  expectedUpdatedAt?: string | null,
  expectedRevision?: number,
): Promise<boolean> {
  const lockToken = await acquireDictionaryLock(entry.guildId);
  if (!lockToken) return false;
  const entryCondition: {
    ConditionExpression?: string;
    ExpressionAttributeNames?: Record<string, string>;
    ExpressionAttributeValues?: Record<string, AttributeValue>;
  } =
    expectedUpdatedAt === undefined
      ? {}
      : expectedUpdatedAt === null
        ? {
            ConditionExpression: "attribute_not_exists(#termKey)",
            ExpressionAttributeNames: { "#termKey": "termKey" },
          }
        : {
            ConditionExpression: "#updatedAt = :expectedUpdatedAt",
            ExpressionAttributeNames: { "#updatedAt": "updatedAt" },
            ExpressionAttributeValues: marshall({
              ":expectedUpdatedAt": expectedUpdatedAt,
            }),
          };
  let ambiguousPutError: unknown;
  let putOutcomeUnknown = false;
  try {
    const currentRevision = await getDictionaryRevision(entry.guildId);
    if (
      expectedRevision !== undefined &&
      expectedRevision !== currentRevision
    ) {
      return false;
    }
    if (
      !(await renewDictionaryLock(
        entry.guildId,
        lockToken,
        DICTIONARY_COMMIT_TTL_SECONDS,
      ))
    ) {
      return false;
    }
    try {
      await dynamoDbClient.send(
        new PutItemCommand({
          TableName: tableName("DictionaryTable"),
          Item: marshall(entry, { removeUndefinedValues: true }),
          ...entryCondition,
        }),
      );
    } catch (error) {
      const persisted = await dictionaryEntryWasPersisted(entry);
      if (persisted === false) throw error;
      if (persisted === undefined) {
        ambiguousPutError = error;
        putOutcomeUnknown = true;
      }
    }
    const reconciled = await reconcileDictionaryRevision(
      entry.guildId,
      lockToken,
      currentRevision,
    );
    if (putOutcomeUnknown) throw ambiguousPutError;
    return reconciled;
  } catch (error) {
    if (isConditionalCheckFailed(error)) return false;
    throw error;
  } finally {
    await releaseDictionaryLock(entry.guildId, lockToken);
  }
}

export async function getDictionaryEntry(
  guildId: string,
  termKey: string,
): Promise<DictionaryEntry | undefined> {
  const params = {
    TableName: tableName("DictionaryTable"),
    Key: marshall({ guildId, termKey }),
    ConsistentRead: true,
  };
  const command = new GetItemCommand(params);
  const result = await dynamoDbClient.send(command);
  if (result.Item) {
    return unmarshall(result.Item) as DictionaryEntry;
  }
  return undefined;
}

export async function listDictionaryEntries(
  guildId: string,
  consistentRead = false,
): Promise<DictionaryEntry[]> {
  const params = {
    TableName: tableName("DictionaryTable"),
    KeyConditionExpression: "guildId = :guildId",
    ExpressionAttributeValues: marshall({
      ":guildId": guildId,
    }),
    ConsistentRead: consistentRead,
  };
  const command = new QueryCommand(params);
  const result = await dynamoDbClient.send(command);
  if (result.Items) {
    return result.Items.map((item) => unmarshall(item) as DictionaryEntry);
  }
  return [];
}

export async function deleteDictionaryEntry(
  guildId: string,
  termKey: string,
): Promise<void> {
  const lockToken = await acquireDictionaryLock(guildId);
  if (!lockToken) throw new Error("Dictionary is busy. Try again.");
  try {
    const currentRevision = await getDictionaryRevision(guildId);
    if (
      !(await renewDictionaryLock(
        guildId,
        lockToken,
        DICTIONARY_COMMIT_TTL_SECONDS,
      ))
    ) {
      throw new Error("Dictionary changed while deleting an entry.");
    }
    const deleteOutcome = await deleteDictionaryEntryRecord(guildId, termKey);
    if (
      !(await reconcileDictionaryRevision(guildId, lockToken, currentRevision))
    ) {
      throw new Error("Dictionary changed while deleting an entry.");
    }
    if (!deleteOutcome.verified) throw deleteOutcome.error;
  } finally {
    await releaseDictionaryLock(guildId, lockToken);
  }
}

export async function clearDictionaryEntries(guildId: string): Promise<void> {
  const lockToken = await acquireDictionaryLock(guildId);
  if (!lockToken) throw new Error("Dictionary is busy. Try again.");
  let deletedAny = false;
  try {
    const currentRevision = await getDictionaryRevision(guildId);
    if (
      !(await renewDictionaryLock(
        guildId,
        lockToken,
        DICTIONARY_COMMIT_TTL_SECONDS,
      ))
    ) {
      throw new Error("Dictionary changed while clearing entries.");
    }
    const entries = await listDictionaryEntries(guildId, true);
    let deleteError: unknown;
    try {
      for (const entry of entries) {
        const deleteOutcome = await deleteDictionaryEntryRecord(
          guildId,
          entry.termKey,
        );
        deletedAny = true;
        if (!deleteOutcome.verified) {
          deleteError = deleteOutcome.error;
          break;
        }
      }
    } catch (error) {
      deleteError = error;
    }
    if (
      deletedAny &&
      !(await reconcileDictionaryRevision(guildId, lockToken, currentRevision))
    ) {
      throw new Error("Dictionary changed while clearing entries.");
    }
    if (deleteError) throw deleteError;
  } finally {
    await releaseDictionaryLock(guildId, lockToken);
  }
}

// Config Overrides operations
export async function writeConfigOverride(
  record: ConfigOverrideRecord,
): Promise<void> {
  const params = {
    TableName: tableName("ConfigOverridesTable"),
    Item: marshall(record, { removeUndefinedValues: true }),
  };
  const command = new PutItemCommand(params);
  await dynamoDbClient.send(command);
}

export async function getConfigOverride(
  scopeId: string,
  configKey: string,
): Promise<ConfigOverrideRecord | undefined> {
  const params = {
    TableName: tableName("ConfigOverridesTable"),
    Key: marshall({ scopeId, configKey }),
  };
  const command = new GetItemCommand(params);
  const result = await dynamoDbClient.send(command);
  if (result.Item) {
    return unmarshall(result.Item) as ConfigOverrideRecord;
  }
  return undefined;
}

export async function deleteConfigOverride(
  scopeId: string,
  configKey: string,
): Promise<void> {
  const params = {
    TableName: tableName("ConfigOverridesTable"),
    Key: marshall({ scopeId, configKey }),
  };
  const command = new DeleteItemCommand(params);
  await dynamoDbClient.send(command);
}

export async function listConfigOverrides(
  scopeId: string,
  signal?: AbortSignal,
): Promise<ConfigOverrideRecord[]> {
  signal?.throwIfAborted();
  const params = {
    TableName: tableName("ConfigOverridesTable"),
    KeyConditionExpression: "scopeId = :scopeId",
    ExpressionAttributeValues: marshall({
      ":scopeId": scopeId,
    }),
  };
  const command = new QueryCommand(params);
  const result = await dynamoDbClient.send(command, { abortSignal: signal });
  signal?.throwIfAborted();
  if (result.Items) {
    return result.Items.map((item) => unmarshall(item) as ConfigOverrideRecord);
  }
  return [];
}

export async function scanConfigOverridesByScopePrefix(
  scopePrefix: string,
): Promise<ConfigOverrideRecord[]> {
  const items: ConfigOverrideRecord[] = [];
  let lastKey: Record<string, AttributeValue> | undefined;

  do {
    const params = {
      TableName: tableName("ConfigOverridesTable"),
      FilterExpression: "begins_with(#scopeId, :scopePrefix)",
      ExpressionAttributeNames: {
        "#scopeId": "scopeId",
      },
      ExpressionAttributeValues: marshall({
        ":scopePrefix": scopePrefix,
      }),
      ExclusiveStartKey: lastKey,
    };
    const command = new ScanCommand(params);
    const result = await dynamoDbClient.send(command);
    if (result.Items) {
      items.push(
        ...result.Items.map((item) => unmarshall(item) as ConfigOverrideRecord),
      );
    }
    lastKey = result.LastEvaluatedKey;
  } while (lastKey);

  return items;
}

export async function getAllChannelContexts(
  guildId: string,
): Promise<ChannelContext[]> {
  const params = {
    TableName: tableName("ChannelContextTable"),
    KeyConditionExpression: "guildId = :guildId",
    ExpressionAttributeValues: marshall({
      ":guildId": guildId,
    }),
  };
  const command = new QueryCommand(params);
  const result = await dynamoDbClient.send(command);
  if (result.Items) {
    return result.Items.map((item) => unmarshall(item) as ChannelContext);
  }
  return [];
}

export async function scanChannelContexts(): Promise<ChannelContext[]> {
  const items: ChannelContext[] = [];
  let lastKey: Record<string, AttributeValue> | undefined;

  do {
    const params = {
      TableName: tableName("ChannelContextTable"),
      ExclusiveStartKey: lastKey,
    };
    const command = new ScanCommand(params);
    const result = await dynamoDbClient.send(command);
    if (result.Items) {
      items.push(
        ...result.Items.map((item) => unmarshall(item) as ChannelContext),
      );
    }
    lastKey = result.LastEvaluatedKey;
  } while (lastKey);

  return items;
}

export async function deleteChannelContext(
  guildId: string,
  channelId: string,
): Promise<void> {
  const params = {
    TableName: tableName("ChannelContextTable"),
    Key: marshall({ guildId, channelId }),
  };
  const command = new DeleteItemCommand(params);
  await dynamoDbClient.send(command);
}

export async function scanServerContexts(): Promise<ServerContext[]> {
  const items: ServerContext[] = [];
  let lastKey: Record<string, AttributeValue> | undefined;

  do {
    const params = {
      TableName: tableName("ServerContextTable"),
      ExclusiveStartKey: lastKey,
    };
    const command = new ScanCommand(params);
    const result = await dynamoDbClient.send(command);
    if (result.Items) {
      items.push(
        ...result.Items.map((item) => unmarshall(item) as ServerContext),
      );
    }
    lastKey = result.LastEvaluatedKey;
  } while (lastKey);

  return items;
}

// Guild installer mapping
export async function writeGuildInstaller(
  installer: GuildInstaller,
): Promise<void> {
  const params = {
    TableName: tableName("InstallerTable"),
    Item: marshall(installer),
  };
  const command = new PutItemCommand(params);
  await dynamoDbClient.send(command);
}

export async function writeGuildInstallerIfAbsent(
  installer: GuildInstaller,
): Promise<boolean> {
  const command = new PutItemCommand({
    TableName: tableName("InstallerTable"),
    Item: marshall(installer),
    ConditionExpression: "attribute_not_exists(guildId)",
  });
  try {
    await dynamoDbClient.send(command);
    return true;
  } catch (error) {
    if (isConditionalCheckFailed(error)) return false;
    throw error;
  }
}

export async function writeGuildInstallerForMembership(
  installer: GuildInstaller,
  joinedAt: string,
): Promise<boolean> {
  const command = new PutItemCommand({
    TableName: tableName("InstallerTable"),
    Item: marshall(installer),
    // Compare atomically so an old membership callback cannot replace a newer one.
    ConditionExpression:
      "attribute_not_exists(guildId) OR installedAt < :joinedAt",
    ExpressionAttributeValues: marshall({ ":joinedAt": joinedAt }),
  });
  try {
    await dynamoDbClient.send(command);
    return true;
  } catch (error) {
    if (isConditionalCheckFailed(error)) return false;
    throw error;
  }
}
export async function deleteGuildInstaller(
  guildId: string,
  removedAt: string,
): Promise<void> {
  const command = new DeleteItemCommand({
    TableName: tableName("InstallerTable"),
    Key: marshall({ guildId }),
    // A delayed removal must not erase a subsequent installation.
    ConditionExpression: "installedAt <= :removedAt",
    ExpressionAttributeValues: marshall({ ":removedAt": removedAt }),
  });
  try {
    await dynamoDbClient.send(command);
  } catch (error) {
    if (isConditionalCheckFailed(error)) return;
    throw error;
  }
}
export async function getGuildInstaller(
  guildId: string,
): Promise<GuildInstaller | undefined> {
  const params = {
    TableName: tableName("InstallerTable"),
    Key: marshall({ guildId }),
  };
  const command = new GetItemCommand(params);
  const result = await dynamoDbClient.send(command);
  if (result.Item) {
    return unmarshall(result.Item) as GuildInstaller;
  }
  return undefined;
}

// Onboarding state helpers
export async function writeOnboardingState(
  state: OnboardingState,
): Promise<void> {
  const params = {
    TableName: tableName("OnboardingStateTable"),
    Item: marshall(state, { removeUndefinedValues: true }),
  };
  const command = new PutItemCommand(params);
  await dynamoDbClient.send(command);
}

export async function getOnboardingState(
  guildId: string,
  userId: string,
): Promise<OnboardingState | undefined> {
  const params = {
    TableName: tableName("OnboardingStateTable"),
    Key: marshall({ guildId, userId }),
  };
  const command = new GetItemCommand(params);
  const result = await dynamoDbClient.send(command);
  if (result.Item) {
    return unmarshall(result.Item) as OnboardingState;
  }
  return undefined;
}

export async function deleteOnboardingState(
  guildId: string,
  userId: string,
): Promise<void> {
  const params = {
    TableName: tableName("OnboardingStateTable"),
    Key: marshall({ guildId, userId }),
  };
  const command = new DeleteItemCommand(params);
  await dynamoDbClient.send(command);
}

// Meeting History operations
export async function writeMeetingHistory(
  history: MeetingHistory,
): Promise<void> {
  const params = {
    TableName: tableName("MeetingHistoryTable"),
    Item: marshall(history, { removeUndefinedValues: true }),
  };
  const command = new PutItemCommand(params);
  await dynamoDbClient.send(command);
}

export async function getRecentMeetingsForChannel(
  guildId: string,
  channelId: string,
  limit: number = 5,
  signal?: AbortSignal,
): Promise<MeetingHistory[]> {
  signal?.throwIfAborted();
  const params = {
    TableName: tableName("MeetingHistoryTable"),
    KeyConditionExpression:
      "guildId = :guildId AND begins_with(channelId_timestamp, :channelId)",
    ExpressionAttributeValues: marshall({
      ":guildId": guildId,
      ":channelId": `${channelId}#`,
    }),
    ScanIndexForward: false, // Get most recent first
    Limit: limit,
  };
  const command = new QueryCommand(params);
  const result = await dynamoDbClient.send(command, { abortSignal: signal });
  signal?.throwIfAborted();
  if (result.Items) {
    return result.Items.map((item) => unmarshall(item) as MeetingHistory);
  }
  return [];
}

export async function getRecentMeetingsForGuild(
  guildId: string,
  limit: number = 10,
  signal?: AbortSignal,
): Promise<MeetingHistory[]> {
  signal?.throwIfAborted();
  const params = {
    TableName: tableName("MeetingHistoryTable"),
    IndexName: "GuildTimestampIndex",
    KeyConditionExpression: "guildId = :guildId",
    ExpressionAttributeValues: marshall({
      ":guildId": guildId,
    }),
    ScanIndexForward: false, // Get most recent first
    Limit: limit,
  };
  const command = new QueryCommand(params);
  const result = await dynamoDbClient.send(command, { abortSignal: signal });
  signal?.throwIfAborted();
  if (result.Items) {
    return result.Items.map((item) => unmarshall(item) as MeetingHistory);
  }
  return [];
}

export async function getMeetingsForGuildInRange(
  guildId: string,
  startTimestamp: string,
  endTimestamp: string,
  limit?: number,
  signal?: AbortSignal,
): Promise<MeetingHistory[]> {
  if (limit !== undefined && limit <= 0) return [];

  const items: MeetingHistory[] = [];
  let lastKey: Record<string, AttributeValue> | undefined;

  do {
    signal?.throwIfAborted();
    const remaining = limit === undefined ? undefined : limit - items.length;
    const params = {
      TableName: tableName("MeetingHistoryTable"),
      IndexName: "GuildTimestampIndex",
      KeyConditionExpression:
        "guildId = :guildId AND #timestamp BETWEEN :start AND :end",
      ExpressionAttributeNames: { "#timestamp": "timestamp" },
      ExpressionAttributeValues: marshall({
        ":guildId": guildId,
        ":start": startTimestamp,
        ":end": endTimestamp,
      }),
      ExclusiveStartKey: lastKey,
      ScanIndexForward: false,
      ...(remaining !== undefined && remaining > 0 ? { Limit: remaining } : {}),
    };
    const command = new QueryCommand(params);
    const result = await dynamoDbClient.send(command, { abortSignal: signal });
    signal?.throwIfAborted();
    if (result.Items) {
      items.push(
        ...result.Items.map((item) => unmarshall(item) as MeetingHistory),
      );
    }
    lastKey = result.LastEvaluatedKey;
  } while (lastKey && (limit === undefined || items.length < limit));

  return limit === undefined ? items : items.slice(0, limit);
}

export async function getMeetingHistory(
  guildId: string,
  channelId_timestamp: string,
): Promise<MeetingHistory | undefined> {
  const params = {
    TableName: tableName("MeetingHistoryTable"),
    Key: marshall({ guildId, channelId_timestamp }),
  };
  const command = new GetItemCommand(params);
  const result = await dynamoDbClient.send(command);
  if (result.Item) {
    return unmarshall(result.Item) as MeetingHistory;
  }
  return undefined;
}

export async function writeMeetingUserIndexRecords(
  records: MeetingUserIndexRecord[],
): Promise<void> {
  for (const record of records) {
    if ("accessReason" in record && record.accessReason === "guild_share") {
      if (!record.userId.startsWith("GUILD_SHARE#"))
        throw new Error("Invalid guild share principal");
    } else {
      assertRawMeetingIndexUserId(record.userId);
    }
  }
  for (
    let index = 0;
    index < records.length;
    index += MEETING_USER_INDEX_WRITE_BATCH_SIZE
  ) {
    await Promise.all(
      records
        .slice(index, index + MEETING_USER_INDEX_WRITE_BATCH_SIZE)
        .map((record) =>
          dynamoDbClient.send(
            new PutItemCommand({
              TableName: tableName("MeetingUserIndexTable"),
              Item: marshall(record, { removeUndefinedValues: true }),
            }),
          ),
        ),
    );
  }
}

export async function deleteMeetingUserIndexRecords(
  records: Pick<MeetingUserIndexRecord, "userId" | "userTimestamp">[],
): Promise<void> {
  for (
    let index = 0;
    index < records.length;
    index += MEETING_USER_INDEX_WRITE_BATCH_SIZE
  ) {
    await Promise.all(
      records
        .slice(index, index + MEETING_USER_INDEX_WRITE_BATCH_SIZE)
        .map((record) =>
          dynamoDbClient.send(
            new DeleteItemCommand({
              TableName: tableName("MeetingUserIndexTable"),
              Key: marshall({
                userId: record.userId,
                userTimestamp: record.userTimestamp,
              }),
            }),
          ),
        ),
    );
  }
}

export async function getMeetingUserIndexRecordsForUserInRange(
  userId: string,
  startTimestamp: string,
  endTimestamp: string,
  limit?: number,
): Promise<MeetingUserIndexRecord[]> {
  assertRawMeetingIndexUserId(userId);
  if (limit !== undefined && limit <= 0) return [];

  const items: MeetingUserIndexRecord[] = [];
  let lastKey: Record<string, AttributeValue> | undefined;

  do {
    const remaining = limit === undefined ? undefined : limit - items.length;
    const params = {
      TableName: tableName("MeetingUserIndexTable"),
      KeyConditionExpression:
        "userId = :userId AND userTimestamp BETWEEN :start AND :end",
      ExpressionAttributeValues: marshall({
        ":userId": userId,
        ":start": `${startTimestamp}#`,
        ":end": `${endTimestamp}#\uffff`,
      }),
      ExclusiveStartKey: lastKey,
      ScanIndexForward: false,
      ...(remaining !== undefined && remaining > 0 ? { Limit: remaining } : {}),
    };
    const command = new QueryCommand(params);
    const result = await dynamoDbClient.send(command);
    if (result.Items) {
      items.push(
        ...result.Items.map(
          (item) => unmarshall(item) as MeetingUserIndexRecord,
        ),
      );
    }
    lastKey = result.LastEvaluatedKey;
  } while (lastKey && (limit === undefined || items.length < limit));

  return limit === undefined ? items : items.slice(0, limit);
}

export async function writePersonalMediaUploadJob(
  job: PersonalMediaUploadJobRecord,
  context: AdmissionContext,
): Promise<void> {
  if (
    !(await transactPersonalAdmission(dynamoDbClient, context, tablePrefix, [
      {
        Put: {
          TableName: tableName("PersonalMediaUploadJobTable"),
          Item: marshall(job, { removeUndefinedValues: true }),
          ConditionExpression: "attribute_not_exists(uploadId)",
        },
      },
    ]))
  )
    throw new Error("Personal upload already exists");
}

export async function getPersonalMediaUploadJob(
  uploadId: string,
): Promise<PersonalMediaUploadJobRecord | undefined> {
  const result = await dynamoDbClient.send(
    new GetItemCommand({
      TableName: tableName("PersonalMediaUploadJobTable"),
      Key: marshall({ uploadId }),
      ConsistentRead: true,
    }),
  );
  return result.Item
    ? (unmarshall(result.Item) as PersonalMediaUploadJobRecord)
    : undefined;
}

export async function submitPersonalMediaUploadJob(
  job: PersonalMediaUploadJobRecord,
  context: AdmissionContext,
): Promise<boolean> {
  return transactPersonalAdmission(dynamoDbClient, context, tablePrefix, [
    ...buildPersonalUploadSubmissionTransaction(job, {
      deploymentControl: tableName("DeploymentControlTable"),
      personalMediaUpload: tableName("PersonalMediaUploadJobTable"),
    }).TransactItems!,
  ]);
}

export function personalMediaClaimForJob(
  job: PersonalMediaUploadJobRecord,
  instanceId: string,
): PersonalMediaClaim {
  if (!job.processingClaimId || !job.attempts)
    throw new Error("Personal processing claim is missing");
  return {
    uploadId: job.uploadId,
    instanceId,
    attempt: job.attempts,
    claimId: job.processingClaimId,
    nowEpochSeconds: Math.floor(Date.now() / 1000),
  };
}

export function personalProcessingHistoryFields(
  history: MeetingHistory,
  existing?: MeetingHistory,
) {
  const superseded = existing
    ? canonicalFieldsSupersededAfter(existing, history.contentRevision ?? 0)
    : new Set<string>();
  if (!superseded) return undefined;
  return Object.entries(history).filter(
    ([key, value]) =>
      value !== undefined &&
      ![
        "guildId",
        "channelId_timestamp",
        "accessGrants",
        "archivedAt",
        "archivedByUserId",
        "contentRevision",
        "contentMutation",
        "updateDelivery",
        "updateDeliveryQueue",
        "updateDeliveryDueAt",
        "publicationRepair",
      ].includes(key) &&
      !superseded.has(key),
  );
}

export async function writePersonalHistoryUnderClaim(
  history: MeetingHistory,
  claim: PersonalMediaClaim,
  terminalJob?: PersonalMediaUploadJobRecord,
): Promise<PersonalHistoryWriteResult> {
  history = { ...history, canonicalWriter: personalCanonicalWriter(claim) };
  const observed = await dynamoDbClient.send(
    new GetItemCommand({
      TableName: tableName("MeetingHistoryTable"),
      Key: marshall({
        guildId: history.guildId,
        channelId_timestamp: history.channelId_timestamp,
      }),
      ConsistentRead: true,
    }),
  );
  const existing = observed.Item
    ? parseMeetingUpdateHistory(unmarshall(observed.Item))
    : undefined;
  const expected = existing
    ? publicationSnapshotCondition(
        publicationSnapshot(existing),
        "personalPublication",
      )
    : undefined;
  const fields = personalProcessingHistoryFields(history, existing);
  if (!fields) return { kind: "stale" };
  const names: Record<string, string> = {
    "#status": "status",
    ...expected?.names,
  };
  const values: Record<string, unknown> = {
    ":meeting": history.meetingId,
    ":owner": history.ownerUserId,
    ":personal": "personal",
    ":processing": "processing",
    ...expected?.values,
  };
  fields.forEach(([key, value], index) => {
    names[`#f${index}`] = key;
    values[`:f${index}`] = value;
  });
  try {
    await dynamoDbClient.send(
      new TransactWriteItemsCommand({
        TransactItems: [
          terminalJob
            ? {
                Put: {
                  TableName: tableName("PersonalMediaUploadJobTable"),
                  Item: marshall(terminalJob, { removeUndefinedValues: true }),
                  ConditionExpression: buildPersonalClaimCheck(claim, "unused")
                    .ConditionCheck.ConditionExpression,
                  ExpressionAttributeNames: buildPersonalClaimCheck(
                    claim,
                    "unused",
                  ).ConditionCheck.ExpressionAttributeNames,
                  ExpressionAttributeValues: buildPersonalClaimCheck(
                    claim,
                    "unused",
                  ).ConditionCheck.ExpressionAttributeValues,
                },
              }
            : buildPersonalClaimCheck(
                claim,
                tableName("PersonalMediaUploadJobTable"),
              ),
          {
            Update: {
              TableName: tableName("MeetingHistoryTable"),
              Key: marshall({
                guildId: history.guildId,
                channelId_timestamp: history.channelId_timestamp,
              }),
              UpdateExpression: `SET ${fields.map((_, index) => `#f${index} = :f${index}`).join(", ")}`,
              ConditionExpression: existing
                ? "(meetingId = :meeting AND ownerUserId = :owner AND ownershipScope = :personal AND #status = :processing) AND " +
                  expected?.condition
                : "attribute_not_exists(guildId)",
              ExpressionAttributeNames: existing
                ? names
                : Object.fromEntries(
                    Object.entries(names).filter(([key]) => key !== "#status"),
                  ),
              ExpressionAttributeValues: marshall(
                existing
                  ? values
                  : Object.fromEntries(
                      Object.entries(values).filter(
                        ([key]) =>
                          ![
                            ":meeting",
                            ":owner",
                            ":personal",
                            ":processing",
                          ].includes(key),
                      ),
                    ),
              ),
            },
          },
        ],
      }),
    );
    return {
      kind: "committed",
      history: parseMeetingUpdateHistory({
        ...existing,
        guildId: history.guildId,
        channelId_timestamp: history.channelId_timestamp,
        ...Object.fromEntries(fields),
      }),
    };
  } catch (error) {
    if (classifyDeploymentTransactionError(error) === "stale")
      return { kind: "stale" };
    throw error;
  }
}

export async function writePersonalSegmentUnderClaim(
  segment: PersonalRecordingSegmentRecord,
  claim: PersonalMediaClaim,
): Promise<boolean> {
  if (segment.uploadId !== claim.uploadId) return false;
  try {
    await dynamoDbClient.send(
      new TransactWriteItemsCommand({
        TransactItems: [
          buildPersonalClaimCheck(
            claim,
            tableName("PersonalMediaUploadJobTable"),
          ),
          {
            Put: {
              TableName: tableName("PersonalRecordingSegmentTable"),
              Item: marshall(segment, { removeUndefinedValues: true }),
              ConditionExpression: "ownerUserId = :owner",
              ExpressionAttributeValues: marshall({
                ":owner": segment.ownerUserId,
              }),
            },
          },
        ],
      }),
    );
    return true;
  } catch (error) {
    if (classifyDeploymentTransactionError(error) === "stale") return false;
    throw error;
  }
}

export async function getPersonalRecordingSegment(
  uploadId: string,
  segmentKey: string,
): Promise<PersonalRecordingSegmentRecord | undefined> {
  const result = await dynamoDbClient.send(
    new GetItemCommand({
      TableName: tableName("PersonalRecordingSegmentTable"),
      Key: marshall({ uploadId, segmentKey }),
    }),
  );
  return result.Item
    ? (unmarshall(result.Item) as PersonalRecordingSegmentRecord)
    : undefined;
}

export async function listPersonalRecordingSegments(
  uploadId: string,
): Promise<PersonalRecordingSegmentRecord[]> {
  const segments: PersonalRecordingSegmentRecord[] = [];
  let exclusiveStartKey: Record<string, AttributeValue> | undefined;
  do {
    const result = await dynamoDbClient.send(
      new QueryCommand({
        TableName: tableName("PersonalRecordingSegmentTable"),
        KeyConditionExpression: "#uploadId = :uploadId",
        ExpressionAttributeNames: { "#uploadId": "uploadId" },
        ExpressionAttributeValues: marshall({ ":uploadId": uploadId }),
        ExclusiveStartKey: exclusiveStartKey,
        ScanIndexForward: true,
      }),
    );
    segments.push(
      ...(result.Items ?? []).map(
        (item) => unmarshall(item) as PersonalRecordingSegmentRecord,
      ),
    );
    exclusiveStartKey = result.LastEvaluatedKey;
  } while (exclusiveStartKey);
  return segments;
}

export async function preparePersonalRecordingSegment(
  segment: PersonalRecordingSegmentRecord,
  expectedStatus: "pending_upload" | "failed" | undefined,
  context: AdmissionContext,
): Promise<boolean> {
  return transactPersonalAdmission(dynamoDbClient, context, tablePrefix, [
    ...buildPendingSegmentTransaction(segment, expectedStatus, {
      deploymentControl: tableName("DeploymentControlTable"),
      personalMediaUpload: tableName("PersonalMediaUploadJobTable"),
      personalRecordingSegment: tableName("PersonalRecordingSegmentTable"),
    }).TransactItems!,
  ]);
}

export async function transitionPersonalRecordingSegment(
  segment: PersonalRecordingSegmentRecord,
  expectedStatus: PersonalRecordingSegmentRecord["status"],
  context: AdmissionContext,
): Promise<boolean> {
  return transactPersonalAdmission(dynamoDbClient, context, tablePrefix, [
    ...buildPersonalSegmentTransitionTransaction(segment, expectedStatus, {
      deploymentControl: tableName("DeploymentControlTable"),
      personalRecordingSegment: tableName("PersonalRecordingSegmentTable"),
    }).TransactItems!,
  ]);
}

export async function listClaimablePersonalMediaUploadJobs(options: {
  instanceId: string;
  nowEpochSeconds: number;
  maxAttempts: number;
  limit: number;
}): Promise<PersonalMediaUploadJobRecord[]> {
  return listUnpausedPersonalMediaUploadJobs(
    dynamoDbClient,
    {
      uploadTable: tableName("PersonalMediaUploadJobTable"),
      statusIndex: PERSONAL_MEDIA_UPLOAD_STATUS_UPDATED_AT_INDEX,
      control: getDeploymentControlRepository(),
    },
    options,
  );
}

export async function claimPersonalMediaUploadJob(options: {
  uploadId: string;
  instanceId: string;
  nowEpochSeconds: number;
  claimExpiresAt: number;
  updatedAt: string;
  maxAttempts: number;
  context: AdmissionContext;
  claimId: string;
  expectedAttempts: number;
}): Promise<PersonalMediaUploadJobRecord | undefined> {
  const previous = await getPersonalMediaUploadJob(options.uploadId);
  if (!previous) return undefined;
  await requireUnpausedDesktopDraft(getDeploymentControlRepository(), previous);
  if (
    previous.processingClaimId === options.claimId &&
    previous.processingOwnerInstanceId === options.instanceId &&
    previous.status === "processing"
  )
    return (previous.claimExpiresAt ?? 0) >= options.nowEpochSeconds
      ? previous
      : undefined;
  if ((previous.attempts ?? 0) !== options.expectedAttempts) return undefined;
  const attempt = options.expectedAttempts + 1;
  const prefix = `personal/${previous.ownerUserId}/${previous.uploadId}/attempt-${attempt}/`;
  const next: PersonalMediaUploadJobRecord = {
    ...previous,
    status: "processing",
    processingOwnerInstanceId: options.instanceId,
    processingClaimId: options.claimId,
    attempts: attempt,
    claimExpiresAt: options.claimExpiresAt,
    updatedAt: options.updatedAt,
    processingStartedAt: previous.processingStartedAt ?? options.updatedAt,
    artifactAttempts: {
      ...previous.artifactAttempts,
      [attempt]: {
        prefix,
        audioS3Key: `${prefix}audio.mp3`,
        transcriptS3Key: `${prefix}transcript.json`,
      },
    },
  };
  const transaction = buildPersonalMediaClaimTransaction(
    {
      ...options,
      job: next,
      context: { ...options.context, now: options.nowEpochSeconds },
    },
    {
      deploymentControl: tableName("DeploymentControlTable"),
      meetingHistory: tableName("MeetingHistoryTable"),
      personalMediaUpload: tableName("PersonalMediaUploadJobTable"),
    },
  );
  try {
    await dynamoDbClient.send(new TransactWriteItemsCommand(transaction));
    return next;
  } catch (error) {
    if (
      completeConditionalCancellation(error, transaction.TransactItems!.length)
    )
      return undefined;
    throw error;
  }
}

export async function renewPersonalMediaUploadJobClaim(
  options: PersonalMediaClaim & { claimExpiresAt: number; updatedAt: string },
): Promise<boolean> {
  const check = buildPersonalClaimCheck(
    options,
    tableName("PersonalMediaUploadJobTable"),
  ).ConditionCheck;
  try {
    await dynamoDbClient.send(
      new UpdateItemCommand({
        ...check,
        UpdateExpression: "SET claimExpiresAt = :expiry, updatedAt = :updated",
        ExpressionAttributeValues: {
          ...check.ExpressionAttributeValues,
          ...marshall({
            ":expiry": options.claimExpiresAt,
            ":updated": options.updatedAt,
          }),
        },
      }),
    );
    return true;
  } catch (error) {
    if (isConditionalCheckFailed(error)) return false;
    throw error;
  }
}
export async function updateClaimedPersonalMediaUploadJobProgress(
  options: PersonalMediaClaim & {
    segmentCount: number;
    uploadedSegmentCount: number;
    processedSegmentCount: number;
    updatedAt: string;
  },
): Promise<boolean> {
  const check = buildPersonalClaimCheck(
    options,
    tableName("PersonalMediaUploadJobTable"),
  ).ConditionCheck;
  try {
    await dynamoDbClient.send(
      new UpdateItemCommand({
        ...check,
        UpdateExpression:
          "SET segmentCount = :segments, uploadedSegmentCount = :uploaded, processedSegmentCount = :processed, updatedAt = :updated",
        ExpressionAttributeValues: {
          ...check.ExpressionAttributeValues,
          ...marshall({
            ":segments": options.segmentCount,
            ":uploaded": options.uploadedSegmentCount,
            ":processed": options.processedSegmentCount,
            ":updated": options.updatedAt,
          }),
        },
      }),
    );
    return true;
  } catch (error) {
    if (isConditionalCheckFailed(error)) return false;
    throw error;
  }
}
export async function writeClaimedPersonalMediaUploadJob(
  job: PersonalMediaUploadJobRecord,
  instanceId: string,
): Promise<boolean> {
  const check = buildPersonalClaimCheck(
    personalMediaClaimForJob(job, instanceId),
    tableName("PersonalMediaUploadJobTable"),
  ).ConditionCheck;
  try {
    await dynamoDbClient.send(
      new PutItemCommand({
        TableName: check.TableName,
        ConditionExpression: check.ConditionExpression,
        ExpressionAttributeNames: check.ExpressionAttributeNames,
        ExpressionAttributeValues: check.ExpressionAttributeValues,
        Item: marshall(job, { removeUndefinedValues: true }),
      }),
    );
    return true;
  } catch (error) {
    if (isConditionalCheckFailed(error)) return false;
    throw error;
  }
}

export async function updateMeetingStatus(
  guildId: string,
  channelId_timestamp: string,
  status: MeetingStatus,
): Promise<void> {
  const now = new Date().toISOString();
  const params: UpdateItemCommand["input"] = {
    TableName: tableName("MeetingHistoryTable"),
    Key: marshall({ guildId, channelId_timestamp }),
    UpdateExpression: "SET #status = :status, #updatedAt = :updatedAt",
    ExpressionAttributeNames: {
      "#status": "status",
      "#updatedAt": "updatedAt",
    },
    ExpressionAttributeValues: marshall(
      {
        ":status": status,
        ":updatedAt": now,
      },
      { removeUndefinedValues: true },
    ),
  };

  const command = new UpdateItemCommand(params);
  await dynamoDbClient.send(command);
}

// Contact Feedback Table
export async function writeContactFeedback(
  record: ContactFeedbackRecord,
): Promise<void> {
  const params = {
    TableName: tableName("ContactFeedbackTable"),
    Item: marshall(record, { removeUndefinedValues: true }),
  };
  const cmd = new PutItemCommand(params);
  await dynamoDbClient.send(cmd);
}

export async function listContactFeedback(params: {
  limit?: number;
  startAt?: string;
  endAt?: string;
}): Promise<ContactFeedbackRecord[]> {
  const expressionNames: Record<string, string> = {
    "#type": "type",
  };
  const expressionValues: Record<string, string> = {
    ":type": "contact_feedback",
  };
  let keyCondition = "#type = :type";

  if (params.startAt && params.endAt) {
    expressionNames["#createdAt"] = "createdAt";
    expressionValues[":startAt"] = params.startAt;
    expressionValues[":endAt"] = params.endAt;
    keyCondition += " AND #createdAt BETWEEN :startAt AND :endAt";
  } else if (params.startAt) {
    expressionNames["#createdAt"] = "createdAt";
    expressionValues[":startAt"] = params.startAt;
    keyCondition += " AND #createdAt >= :startAt";
  } else if (params.endAt) {
    expressionNames["#createdAt"] = "createdAt";
    expressionValues[":endAt"] = params.endAt;
    keyCondition += " AND #createdAt < :endAt";
  }

  const query = new QueryCommand({
    TableName: tableName("ContactFeedbackTable"),
    IndexName: "TypeCreatedAtIndex",
    KeyConditionExpression: keyCondition,
    ExpressionAttributeNames: expressionNames,
    ExpressionAttributeValues: marshall(expressionValues, {
      removeUndefinedValues: true,
    }),
    ScanIndexForward: false,
    Limit: params.limit ?? 50,
  });
  const result = await dynamoDbClient.send(query);
  if (result.Items) {
    return result.Items.map(
      (item) => unmarshall(item) as ContactFeedbackRecord,
    );
  }
  return [];
}

export async function updateMeetingArchive(params: {
  guildId: string;
  channelId_timestamp: string;
  archived: boolean;
  archivedByUserId: string;
}): Promise<boolean> {
  const now = new Date().toISOString();
  const updateParts = ["#updatedAt = :updatedAt"];
  const removeParts: string[] = [];
  const expressionAttributeNames: Record<string, string> = {
    "#updatedAt": "updatedAt",
    "#channelIdTimestamp": "channelId_timestamp",
  };
  const values: Record<string, unknown> = {
    ":updatedAt": now,
  };

  if (params.archived) {
    updateParts.push("#archivedAt = :archivedAt");
    updateParts.push("#archivedByUserId = :archivedByUserId");
    expressionAttributeNames["#archivedAt"] = "archivedAt";
    expressionAttributeNames["#archivedByUserId"] = "archivedByUserId";
    values[":archivedAt"] = now;
    values[":archivedByUserId"] = params.archivedByUserId;
  } else {
    removeParts.push("#archivedAt", "#archivedByUserId");
    expressionAttributeNames["#archivedAt"] = "archivedAt";
    expressionAttributeNames["#archivedByUserId"] = "archivedByUserId";
  }

  const updateExpression = [
    `SET ${updateParts.join(", ")}`,
    removeParts.length > 0 ? `REMOVE ${removeParts.join(", ")}` : null,
  ]
    .filter(Boolean)
    .join(" ");

  const request: UpdateItemCommand["input"] = {
    TableName: tableName("MeetingHistoryTable"),
    Key: marshall({
      guildId: params.guildId,
      channelId_timestamp: params.channelId_timestamp,
    }),
    UpdateExpression: updateExpression,
    ExpressionAttributeNames: expressionAttributeNames,
    ExpressionAttributeValues: marshall(values, {
      removeUndefinedValues: true,
    }),
    ConditionExpression: "attribute_exists(#channelIdTimestamp)",
  };

  const command = new UpdateItemCommand(request);
  try {
    await dynamoDbClient.send(command);
    return true;
  } catch (error) {
    if (
      (error as { name?: string }).name === "ConditionalCheckFailedException"
    ) {
      return false;
    }
    console.error("Failed to update meeting archive:", error);
    return false;
  }
}

function buildAskPartitionKey(userId: string, guildId: string) {
  return `USER#${userId}#GUILD#${guildId}`;
}

function buildAskSharePartitionKey(guildId: string) {
  return `GUILD#${guildId}`;
}

export async function listAskConversations(
  userId: string,
  guildId: string,
): Promise<AskConversationRecord[]> {
  const pk = buildAskPartitionKey(userId, guildId);
  const params = {
    TableName: tableName("AskConversationTable"),
    KeyConditionExpression: "pk = :pk and begins_with(sk, :prefix)",
    ExpressionAttributeValues: marshall({
      ":pk": pk,
      ":prefix": "CONV#",
    }),
  };
  const command = new QueryCommand(params);
  const result = await dynamoDbClient.send(command);
  if (result.Items) {
    return result.Items.map(
      (item) => unmarshall(item) as AskConversationRecord,
    );
  }
  return [];
}

export async function getAskConversation(
  userId: string,
  guildId: string,
  conversationId: string,
): Promise<AskConversationRecord | undefined> {
  const pk = buildAskPartitionKey(userId, guildId);
  const sk = `CONV#${conversationId}`;
  const params = {
    TableName: tableName("AskConversationTable"),
    Key: marshall({ pk, sk }),
  };
  const command = new GetItemCommand(params);
  const result = await dynamoDbClient.send(command);
  if (result.Item) {
    return unmarshall(result.Item) as AskConversationRecord;
  }
  return undefined;
}

export async function listAskMessages(
  userId: string,
  guildId: string,
  conversationId: string,
): Promise<AskMessageRecord[]> {
  const pk = buildAskPartitionKey(userId, guildId);
  const params = {
    TableName: tableName("AskConversationTable"),
    KeyConditionExpression: "pk = :pk and begins_with(sk, :prefix)",
    ExpressionAttributeValues: marshall({
      ":pk": pk,
      ":prefix": `MSG#${conversationId}#`,
    }),
  };
  const command = new QueryCommand(params);
  const result = await dynamoDbClient.send(command);
  if (result.Items) {
    return result.Items.map((item) => unmarshall(item) as AskMessageRecord);
  }
  return [];
}

export async function writeAskConversation(
  record: AskConversationRecord,
): Promise<void> {
  const params = {
    TableName: tableName("AskConversationTable"),
    Item: marshall(record, { removeUndefinedValues: true }),
  };
  const command = new PutItemCommand(params);
  await dynamoDbClient.send(command);
}

export async function writeAskMessage(record: AskMessageRecord): Promise<void> {
  const params = {
    TableName: tableName("AskConversationTable"),
    Item: marshall(record, { removeUndefinedValues: true }),
  };
  const command = new PutItemCommand(params);
  await dynamoDbClient.send(command);
}

export async function listAskConversationShares(
  guildId: string,
): Promise<AskConversationShareRecord[]> {
  const pk = buildAskSharePartitionKey(guildId);
  const params = {
    TableName: tableName("AskConversationTable"),
    KeyConditionExpression: "pk = :pk and begins_with(sk, :prefix)",
    ExpressionAttributeValues: marshall({
      ":pk": pk,
      ":prefix": "SHARE#",
    }),
  };
  const command = new QueryCommand(params);
  const result = await dynamoDbClient.send(command);
  if (result.Items) {
    return result.Items.map(
      (item) => unmarshall(item) as AskConversationShareRecord,
    );
  }
  return [];
}

export async function getAskConversationShare(
  guildId: string,
  conversationId: string,
): Promise<AskConversationShareRecord | undefined> {
  const pk = buildAskSharePartitionKey(guildId);
  const sk = `SHARE#${conversationId}`;
  const params = {
    TableName: tableName("AskConversationTable"),
    Key: marshall({ pk, sk }),
  };
  const command = new GetItemCommand(params);
  const result = await dynamoDbClient.send(command);
  if (result.Item) {
    return unmarshall(result.Item) as AskConversationShareRecord;
  }
  return undefined;
}

export async function writeAskConversationShare(
  record: AskConversationShareRecord,
): Promise<void> {
  const params = {
    TableName: tableName("AskConversationTable"),
    Item: marshall(record, { removeUndefinedValues: true }),
  };
  const command = new PutItemCommand(params);
  await dynamoDbClient.send(command);
}

export async function deleteAskConversationShare(
  guildId: string,
  conversationId: string,
): Promise<void> {
  const pk = buildAskSharePartitionKey(guildId);
  const sk = `SHARE#${conversationId}`;
  const params = {
    TableName: tableName("AskConversationTable"),
    Key: marshall({ pk, sk }),
  };
  const command = new DeleteItemCommand(params);
  await dynamoDbClient.send(command);
}

const buildMeetingSharePartitionKey = (guildId: string) => `GUILD#${guildId}`;
const buildMeetingShareMeetingKey = (meetingId: string) =>
  `MEETING#${meetingId}`;
const buildMeetingShareShareKey = (shareId: string) => `SHARE#${shareId}`;

export async function getMeetingShareByShareId(
  guildId: string,
  shareId: string,
): Promise<MeetingShareRecord | undefined> {
  const pk = buildMeetingSharePartitionKey(guildId);
  const sk = buildMeetingShareShareKey(shareId);
  const params = {
    TableName: tableName("MeetingShareTable"),
    Key: marshall({ pk, sk }),
  };
  const command = new GetItemCommand(params);
  const result = await dynamoDbClient.send(command);
  if (result.Item) {
    return unmarshall(result.Item) as MeetingShareRecord;
  }
  return undefined;
}

export async function getMeetingShareByMeetingId(
  guildId: string,
  meetingId: string,
): Promise<MeetingShareByMeetingRecord | undefined> {
  const pk = buildMeetingSharePartitionKey(guildId);
  const sk = buildMeetingShareMeetingKey(meetingId);
  const params = {
    TableName: tableName("MeetingShareTable"),
    Key: marshall({ pk, sk }),
  };
  const command = new GetItemCommand(params);
  const result = await dynamoDbClient.send(command);
  if (result.Item) {
    return unmarshall(result.Item) as MeetingShareByMeetingRecord;
  }
  return undefined;
}

export async function writeMeetingShare(
  record: MeetingShareRecord,
): Promise<void> {
  const params = {
    TableName: tableName("MeetingShareTable"),
    Item: marshall(record, { removeUndefinedValues: true }),
  };
  const command = new PutItemCommand(params);
  await dynamoDbClient.send(command);
}

export async function writeMeetingShareByMeeting(
  record: MeetingShareByMeetingRecord,
): Promise<void> {
  const params = {
    TableName: tableName("MeetingShareTable"),
    Item: marshall(record, { removeUndefinedValues: true }),
  };
  const command = new PutItemCommand(params);
  await dynamoDbClient.send(command);
}

export async function deleteMeetingShareByShareId(
  guildId: string,
  shareId: string,
): Promise<void> {
  const pk = buildMeetingSharePartitionKey(guildId);
  const sk = buildMeetingShareShareKey(shareId);
  const params = {
    TableName: tableName("MeetingShareTable"),
    Key: marshall({ pk, sk }),
  };
  const command = new DeleteItemCommand(params);
  await dynamoDbClient.send(command);
}

export async function deleteMeetingShareByMeetingId(
  guildId: string,
  meetingId: string,
): Promise<void> {
  const pk = buildMeetingSharePartitionKey(guildId);
  const sk = buildMeetingShareMeetingKey(meetingId);
  const params = {
    TableName: tableName("MeetingShareTable"),
    Key: marshall({ pk, sk }),
  };
  const command = new DeleteItemCommand(params);
  await dynamoDbClient.send(command);
}

export async function writeFeedback(record: FeedbackRecord): Promise<void> {
  const params = {
    TableName: tableName("FeedbackTable"),
    Item: marshall(record, { removeUndefinedValues: true }),
  };
  const command = new PutItemCommand(params);
  await dynamoDbClient.send(command);
}

export async function getFeedback(
  pk: string,
  sk: string,
): Promise<FeedbackRecord | undefined> {
  const params = {
    TableName: tableName("FeedbackTable"),
    Key: marshall({ pk, sk }),
  };
  const command = new GetItemCommand(params);
  const result = await dynamoDbClient.send(command);
  if (result.Item) {
    return unmarshall(result.Item) as FeedbackRecord;
  }
  return undefined;
}

export async function listFeedbackByTargetType(params: {
  targetType: FeedbackTargetType;
  limit?: number;
  startAt?: string;
  endAt?: string;
}): Promise<FeedbackRecord[]> {
  const expressionNames: Record<string, string> = {
    "#targetType": "targetType",
  };
  const expressionValues: Record<string, string> = {
    ":targetType": params.targetType,
  };
  let keyCondition = "#targetType = :targetType";

  if (params.startAt && params.endAt) {
    expressionNames["#createdAt"] = "createdAt";
    expressionValues[":startAt"] = params.startAt;
    expressionValues[":endAt"] = params.endAt;
    keyCondition += " AND #createdAt >= :startAt AND #createdAt < :endAt";
  } else if (params.startAt) {
    expressionNames["#createdAt"] = "createdAt";
    expressionValues[":startAt"] = params.startAt;
    keyCondition += " AND #createdAt >= :startAt";
  } else if (params.endAt) {
    expressionNames["#createdAt"] = "createdAt";
    expressionValues[":endAt"] = params.endAt;
    keyCondition += " AND #createdAt < :endAt";
  }

  const query = new QueryCommand({
    TableName: tableName("FeedbackTable"),
    IndexName: "TargetTypeCreatedAtIndex",
    KeyConditionExpression: keyCondition,
    ExpressionAttributeNames: expressionNames,
    ExpressionAttributeValues: marshall(expressionValues, {
      removeUndefinedValues: true,
    }),
    ScanIndexForward: false,
    Limit: params.limit ?? 100,
  });
  const result = await dynamoDbClient.send(query);
  if (result.Items) {
    return result.Items.map((item) => unmarshall(item) as FeedbackRecord);
  }
  return [];
}

export async function updateMeetingTags(
  guildId: string,
  channelId_timestamp: string,
  tags?: string[],
): Promise<void> {
  const params: UpdateItemCommand["input"] = {
    TableName: tableName("MeetingHistoryTable"),
    Key: marshall({ guildId, channelId_timestamp }),
    UpdateExpression: "SET #tags = :tags",
    ExpressionAttributeNames: {
      "#tags": "tags",
    },
    ExpressionAttributeValues: marshall(
      {
        ":tags": tags ?? [],
      },
      { removeUndefinedValues: false },
    ),
  };

  const command = new UpdateItemCommand(params);
  await dynamoDbClient.send(command);
}

export async function updateMeetingAccessGrants(params: {
  guildId: string;
  channelId_timestamp: string;
  accessGrants: MeetingAccessGrant[];
}): Promise<boolean> {
  const now = new Date().toISOString();
  const request: UpdateItemCommand["input"] = {
    TableName: tableName("MeetingHistoryTable"),
    Key: marshall({
      guildId: params.guildId,
      channelId_timestamp: params.channelId_timestamp,
    }),
    UpdateExpression:
      "SET #accessGrants = :accessGrants, #updatedAt = :updatedAt",
    ConditionExpression: "attribute_exists(#channelIdTimestamp)",
    ExpressionAttributeNames: {
      "#accessGrants": "accessGrants",
      "#updatedAt": "updatedAt",
      "#channelIdTimestamp": "channelId_timestamp",
    },
    ExpressionAttributeValues: marshall(
      {
        ":accessGrants": params.accessGrants,
        ":updatedAt": now,
      },
      { removeUndefinedValues: true },
    ),
  };
  try {
    await dynamoDbClient.send(new UpdateItemCommand(request));
    return true;
  } catch (error) {
    if (isConditionalCheckFailed(error)) return false;
    throw error;
  }
}

// Purchase control records deliberately use a non-guild namespace and never enter
// SubscriptionRepository. No TTL: an unknown provider outcome must remain blocked.
const purchaseRecordKey = (guildId: string) => {
  if (!/^\d{17,20}$/.test(guildId))
    throw new Error("Invalid purchase guild ID");
  return `PURCHASE#${guildId}`;
};
export async function readPurchaseAttempt(
  guildId: string,
): Promise<PurchaseAttempt | undefined> {
  const result = await dynamoDbClient.send(
    new GetItemCommand({
      TableName: tableName("GuildSubscriptionTable"),
      Key: marshall({ guildId: purchaseRecordKey(guildId) }),
      ConsistentRead: true,
    }),
  );
  if (!result.Item) return undefined;
  const record = unmarshall(result.Item);
  return { ...record, guildId } as PurchaseAttempt;
}
export async function compareAndWritePurchaseAttempt(
  next: PurchaseAttempt,
  expected: PurchaseAttempt | undefined,
  pointer: GuildSubscription | undefined,
  incident?: PurchaseIncident,
  offerUsage?: OfferUsageMutation,
): Promise<boolean> {
  assertPurchaseInvoiceBinding(next, expected);
  const usage =
    offerUsage &&
    parseOfferUsageChange({ ...offerUsage, pointer, operation: next });
  const names: Record<string, string> = { "#guildId": "guildId" };
  const values: Record<string, string> = {};
  const conditions = [
    pointer ? "attribute_exists(#guildId)" : "attribute_not_exists(#guildId)",
  ];
  if (pointer)
    for (const key of ["stripeSubscriptionId", "stripeSyncRevision"] as const) {
      names[`#${key}`] = key;
      if (pointer[key] === undefined)
        conditions.push(`attribute_not_exists(#${key})`);
      else {
        conditions.push(`#${key} = :${key}`);
        values[`:${key}`] = pointer[key];
      }
    }
  try {
    await dynamoDbClient.send(
      new TransactWriteItemsCommand({
        TransactItems: [
          {
            ConditionCheck: {
              TableName: tableName("GuildSubscriptionTable"),
              Key: marshall({ guildId: next.guildId }),
              ConditionExpression: conditions.join(" AND "),
              ExpressionAttributeNames: names,
              ...(Object.keys(values).length
                ? { ExpressionAttributeValues: marshall(values) }
                : {}),
            },
          },
          {
            Put: {
              TableName: tableName("GuildSubscriptionTable"),
              Item: marshall(
                { ...next, guildId: purchaseRecordKey(next.guildId) },
                { removeUndefinedValues: true },
              ),
              ConditionExpression: expected
                ? "#revision = :revision"
                : "attribute_not_exists(#guildId)",
              ExpressionAttributeNames: expected
                ? { "#revision": "revision" }
                : { "#guildId": "guildId" },
              ...(expected
                ? {
                    ExpressionAttributeValues: marshall({
                      ":revision": expected.revision,
                    }),
                  }
                : {}),
            },
          },
          ...(next.state === "preparing" &&
          next.attemptId !== expected?.attemptId
            ? [
                {
                  ConditionCheck: historicalRevisionFence(
                    billingChangeControlKey(next.guildId),
                    undefined,
                  ),
                },
                {
                  ConditionCheck: renewalRecoveryFence(next.guildId),
                },
              ]
            : []),
          ...(usage
            ? [
                { Put: offerUsagePut(usage.next, usage.expected) },
                ...offerAuthorityFences(usage.authority),
              ]
            : []),
          ...(incident
            ? [
                {
                  Update: purchaseIncidentUpdate(incident),
                },
              ]
            : []),
        ],
      }),
    );
    return true;
  } catch (error) {
    const cancellation = error as TransactionCanceledException;
    if (
      cancellation.name === "TransactionCanceledException" &&
      cancellation.CancellationReasons?.some(
        (reason) =>
          reason.Code === "ConditionalCheckFailed" ||
          reason.Code === "TransactionConflict",
      ) &&
      cancellation.CancellationReasons.every(
        (reason) =>
          !reason.Code ||
          ["None", "ConditionalCheckFailed", "TransactionConflict"].includes(
            reason.Code,
          ),
      )
    ) {
      await new Promise((resolve) =>
        setTimeout(resolve, 25 + Math.floor(Math.random() * 50)),
      );
      return false;
    }
    throw error;
  }
}

function stripeWebhookDynamoRepository() {
  return createStripeWebhookDynamoRepository(
    dynamoDbClient,
    tableName("StripeWebhookEventTable"),
    {
      deploymentControl: tableName("DeploymentControlTable"),
      meetingHistory: tableName("MeetingHistoryTable"),
    },
  );
}
export const claimStripeWebhookEvent = (event: StripeWebhookEvent) =>
  stripeWebhookDynamoRepository().claim(event);
export const finishStripeWebhookEvent = (
  eventId: string,
  token: string,
  release: boolean,
) => stripeWebhookDynamoRepository().finish(eventId, token, release);
export const admitStripeWebhookEvent = (
  eventId: string,
  token: string,
  attemptId: string,
  context: AdmissionContext,
) => stripeWebhookDynamoRepository().admit(eventId, token, attemptId, context);
export const failStripeWebhookEvent = (eventId: string, token: string) =>
  stripeWebhookDynamoRepository().fail(eventId, token);

function purchaseIncidentUpdate(incident: PurchaseIncident) {
  const { guildId: originalGuildId, key, ...fields } = incident;
  const names: Record<string, string> = {};
  const values: Record<string, string> = {};
  const expressions: string[] = [];
  for (const [name, value] of Object.entries({ ...fields, originalGuildId })) {
    if (value === undefined) continue;
    names[`#${name}`] = name;
    values[`:${name}`] = value;
    expressions.push(
      ["firstObservedAt", "incomingAttemptId"].includes(name)
        ? `#${name} = if_not_exists(#${name}, :${name})`
        : `#${name} = :${name}`,
    );
  }
  return {
    TableName: tableName("GuildSubscriptionTable"),
    Key: marshall({ guildId: key }),
    UpdateExpression: `SET ${expressions.join(", ")}`,
    ExpressionAttributeNames: names,
    ExpressionAttributeValues: marshall(values),
  };
}

export async function readOfferUsage(
  guildId: string,
  offerId: IntroOfferId,
  mode: ProviderMode,
): Promise<OfferUsage | undefined> {
  const key = offerUsageKey(guildId, offerId, mode);
  const result = await dynamoDbClient.send(
    new GetItemCommand({
      TableName: tableName("GuildSubscriptionTable"),
      Key: marshall({ guildId: key }),
      ConsistentRead: true,
    }),
  );
  if (!result.Item) return undefined;
  const { guildId: storedKey, serverId, ...record } = unmarshall(result.Item);
  if (
    storedKey !== key ||
    serverId !== guildId ||
    record.offerId !== offerId ||
    record.mode !== mode
  )
    throw new Error("Stored offer usage scope mismatch");
  return offerUsageSchema.parse({ ...record, guildId });
}
function subscriptionRevisionFence(
  guildId: string,
  pointer: GuildSubscription | undefined,
) {
  const names: Record<string, string> = { "#guildId": "guildId" };
  const values: Record<string, string> = {};
  const conditions = [
    pointer ? "attribute_exists(#guildId)" : "attribute_not_exists(#guildId)",
  ];
  if (pointer)
    for (const key of ["stripeSubscriptionId", "stripeSyncRevision"] as const) {
      names[`#${key}`] = key;
      if (pointer[key] === undefined)
        conditions.push(`attribute_not_exists(#${key})`);
      else {
        conditions.push(`#${key} = :${key}`);
        values[`:${key}`] = pointer[key];
      }
    }
  return {
    TableName: tableName("GuildSubscriptionTable"),
    Key: marshall({ guildId }),
    ConditionExpression: conditions.join(" AND "),
    ExpressionAttributeNames: names,
    ...(Object.keys(values).length
      ? { ExpressionAttributeValues: marshall(values) }
      : {}),
  };
}
export async function compareAndWriteOfferUsage(
  input: OfferUsageWrite,
): Promise<boolean> {
  const { next, expected, authority } = parseOfferUsageChange(input);
  try {
    await dynamoDbClient.send(
      new TransactWriteItemsCommand({
        TransactItems: [
          {
            ConditionCheck: subscriptionRevisionFence(
              next.guildId,
              input.pointer,
            ),
          },
          {
            ConditionCheck: {
              TableName: tableName("GuildSubscriptionTable"),
              Key: marshall({ guildId: purchaseRecordKey(next.guildId) }),
              ConditionExpression:
                "#revision = :revision AND #attemptId = :attemptId AND #mode = :mode",
              ExpressionAttributeNames: {
                "#revision": "revision",
                "#attemptId": "attemptId",
                "#mode": "mode",
              },
              ExpressionAttributeValues: marshall({
                ":revision": input.operation.revision,
                ":attemptId": input.operation.attemptId,
                ":mode": next.mode,
              }),
            },
          },
          { Put: offerUsagePut(next, expected) },
          ...offerAuthorityFences(authority),
        ],
      }),
    );
    return true;
  } catch (error) {
    if (isBillingTransactionConflict(error)) return false;
    throw error;
  }
}
function isBillingTransactionConflict(error: unknown): boolean {
  const failure = billingCancellationSchema.safeParse(error);
  if (!failure.success) return false;
  const codes = failure.data.CancellationReasons.map((reason) => reason.Code);
  return (
    codes.some(
      (code) =>
        code === "ConditionalCheckFailed" || code === "TransactionConflict",
    ) &&
    codes.every(
      (code) =>
        !code ||
        ["None", "ConditionalCheckFailed", "TransactionConflict"].includes(
          code,
        ),
    )
  );
}
const billingCancellationSchema = z.object({
  name: z.literal("TransactionCanceledException"),
  CancellationReasons: z.array(z.object({ Code: z.string().optional() })),
});

function offerUsagePut(
  next: OfferUsage,
  expected: OfferUsage | undefined,
): Put {
  return {
    TableName: tableName("GuildSubscriptionTable"),
    Item: marshall({
      ...next,
      guildId: offerUsageKey(next.guildId, next.offerId, next.mode),
      serverId: next.guildId,
    }),
    ConditionExpression: expected
      ? "#revision = :revision"
      : "attribute_not_exists(#guildId)",
    ExpressionAttributeNames: expected
      ? { "#revision": "revision" }
      : { "#guildId": "guildId" },
    ...(expected
      ? {
          ExpressionAttributeValues: marshall({
            ":revision": expected.revision,
          }),
        }
      : {}),
  };
}

export async function readHistoricalOfferImport(
  guildId: string,
  offerId: IntroOfferId,
  mode: ProviderMode,
  accountId: string,
): Promise<HistoricalOfferImport | undefined> {
  const key = historicalOfferImportKey(guildId, offerId, mode, accountId);
  const result = await dynamoDbClient.send(
    new GetItemCommand({
      TableName: tableName("GuildSubscriptionTable"),
      Key: marshall({ guildId: key }),
      ConsistentRead: true,
    }),
  );
  if (!result.Item) return undefined;
  const { guildId: storedKey, serverId, ...record } = unmarshall(result.Item);
  if (
    storedKey !== key ||
    serverId !== guildId ||
    record.accountId !== accountId ||
    record.mode !== mode ||
    record.offerId !== offerId
  )
    throw new Error("Stored historical import scope mismatch");
  return historicalOfferImportSchema.parse({ ...record, guildId });
}
export async function compareAndWriteHistoricalOfferImport(
  input: HistoricalOfferImportWrite,
): Promise<boolean> {
  const { next, expected, usageNext, usageExpected } =
    parseHistoricalOfferImportWrite(input);
  const key = historicalOfferImportKey(
    next.guildId,
    next.offerId,
    next.mode,
    next.accountId,
  );
  try {
    await dynamoDbClient.send(
      new TransactWriteItemsCommand({
        TransactItems: [
          {
            ConditionCheck: subscriptionRevisionFence(
              next.guildId,
              input.pointer,
            ),
          },
          {
            ConditionCheck: historicalOperationFence(
              next.guildId,
              input.operation,
            ),
          },
          usageNext
            ? { Put: offerUsagePut(usageNext, usageExpected) }
            : {
                ConditionCheck: historicalRevisionFence(
                  offerUsageKey(next.guildId, next.offerId, next.mode),
                  usageExpected?.revision,
                ),
              },
          {
            Put: {
              ...historicalImportPut(key, next, expected?.revision),
            },
          },
          ...(next.state === "unused"
            ? [{ ConditionCheck: historyWriterBoundaryFence(next) }]
            : []),
        ],
      }),
    );
    return true;
  } catch (error) {
    if (isBillingTransactionConflict(error)) return false;
    throw error;
  }
}
function historicalRevisionFence(
  key: string,
  revision: string | undefined,
): ConditionCheck {
  return {
    TableName: tableName("GuildSubscriptionTable"),
    Key: marshall({ guildId: key }),
    ConditionExpression: revision
      ? "#revision = :revision"
      : "attribute_not_exists(#guildId)",
    ExpressionAttributeNames: revision
      ? { "#revision": "revision" }
      : { "#guildId": "guildId" },
    ...(revision
      ? { ExpressionAttributeValues: marshall({ ":revision": revision }) }
      : {}),
  };
}
function historicalOperationFence(
  guildId: string,
  operation: PurchaseAttempt | undefined,
): ConditionCheck {
  if (!operation)
    return historicalRevisionFence(purchaseRecordKey(guildId), undefined);
  return {
    TableName: tableName("GuildSubscriptionTable"),
    Key: marshall({ guildId: purchaseRecordKey(guildId) }),
    ConditionExpression:
      "#revision = :revision AND #attemptId = :attemptId AND #mode = :mode",
    ExpressionAttributeNames: {
      "#revision": "revision",
      "#attemptId": "attemptId",
      "#mode": "mode",
    },
    ExpressionAttributeValues: marshall({
      ":revision": operation.revision,
      ":attemptId": operation.attemptId,
      ":mode": operation.mode,
    }),
  };
}

function historicalImportPut(
  key: string,
  next: HistoricalOfferImport,
  revision: string | undefined,
): Put {
  const fence = historicalRevisionFence(key, revision);
  return {
    TableName: fence.TableName,
    Item: marshall({ ...next, guildId: key, serverId: next.guildId }),
    ConditionExpression: fence.ConditionExpression,
    ExpressionAttributeNames: fence.ExpressionAttributeNames,
    ...(fence.ExpressionAttributeValues
      ? { ExpressionAttributeValues: fence.ExpressionAttributeValues }
      : {}),
  };
}

function historyWriterBoundaryFence(
  next: Extract<HistoricalOfferImport, { state: "unused" }>,
): ConditionCheck {
  return {
    TableName: tableName("GuildSubscriptionTable"),
    Key: marshall({
      guildId: historyWriterBoundaryKey(next.accountId, next.mode),
    }),
    ConditionExpression:
      "#revision = :revision AND #state = :state AND #version = :version AND #cutover <= :cutoff AND #verified <= :verified",
    ExpressionAttributeNames: {
      "#revision": "revision",
      "#state": "state",
      "#version": "writerVersion",
      "#cutover": "cutoverAt",
      "#verified": "verifiedAt",
    },
    ExpressionAttributeValues: marshall({
      ":revision": next.writerBoundaryRevision,
      ":state": "verified",
      ":version": HISTORY_WRITER_VERSION,
      ":cutoff": next.createdBefore * 1000,
      ":verified": next.verifiedAt,
    }),
  };
}
export async function readHistoryWriterBoundary(
  accountId: string,
  mode: ProviderMode,
): Promise<HistoryWriterBoundary | undefined> {
  const key = historyWriterBoundaryKey(accountId, mode);
  const result = await dynamoDbClient.send(
    new GetItemCommand({
      TableName: tableName("GuildSubscriptionTable"),
      Key: marshall({ guildId: key }),
      ConsistentRead: true,
    }),
  );
  if (!result.Item) return undefined;
  const { guildId: storedKey, ...record } = unmarshall(result.Item);
  if (
    storedKey !== key ||
    record.accountId !== accountId ||
    record.mode !== mode
  )
    throw new Error("Stored writer boundary scope mismatch");
  return historyWriterBoundarySchema.parse(record);
}

export async function compareAndWriteHistoryWriterBoundary(
  next: HistoryWriterBoundary,
  expected: HistoryWriterBoundary | undefined,
  sample: PurchaseAttempt,
): Promise<boolean> {
  validateBoundarySample(next, expected, sample);
  const key = historyWriterBoundaryKey(next.accountId, next.mode);
  const fence = historicalRevisionFence(key, expected?.revision);
  try {
    await dynamoDbClient.send(
      new TransactWriteItemsCommand({
        TransactItems: [
          { ConditionCheck: historicalOperationFence(sample.guildId, sample) },
          {
            Put: {
              TableName: fence.TableName,
              Item: marshall({ ...next, guildId: key }),
              ConditionExpression: fence.ConditionExpression,
              ExpressionAttributeNames: fence.ExpressionAttributeNames,
              ...(fence.ExpressionAttributeValues
                ? { ExpressionAttributeValues: fence.ExpressionAttributeValues }
                : {}),
            },
          },
        ],
      }),
    );
    return true;
  } catch (error) {
    if (isBillingTransactionConflict(error)) return false;
    throw error;
  }
}
export async function removeHistoryWriterBoundary(
  expected: HistoryWriterBoundary,
): Promise<boolean> {
  historyWriterBoundarySchema.parse(expected);
  const fence = historicalRevisionFence(
    historyWriterBoundaryKey(expected.accountId, expected.mode),
    expected.revision,
  );
  try {
    await dynamoDbClient.send(
      new TransactWriteItemsCommand({ TransactItems: [{ Delete: fence }] }),
    );
    return true;
  } catch (error) {
    if (isBillingTransactionConflict(error)) return false;
    throw error;
  }
}

function offerAuthorityFences(
  authority: IntroOfferAuthority | undefined,
): { ConditionCheck: ConditionCheck }[] {
  if (!authority) return [];
  return [
    {
      ConditionCheck: {
        ...historicalRevisionFence(
          historicalOfferImportKey(
            authority.guildId,
            authority.offerId,
            authority.mode,
            authority.accountId,
          ),
          authority.coverageRevision,
        ),
        ConditionExpression:
          "#revision = :revision AND #state = :state AND #boundary = :boundary",
        ExpressionAttributeNames: {
          "#revision": "revision",
          "#state": "state",
          "#boundary": "writerBoundaryRevision",
        },
        ExpressionAttributeValues: marshall({
          ":revision": authority.coverageRevision,
          ":state": "unused",
          ":boundary": authority.boundaryRevision,
        }),
      },
    },
    {
      ConditionCheck: {
        ...historicalRevisionFence(
          historyWriterBoundaryKey(authority.accountId, authority.mode),
          authority.boundaryRevision,
        ),
        ConditionExpression:
          "#revision = :revision AND #state = :state AND #deployment.#image = :image",
        ExpressionAttributeNames: {
          "#revision": "revision",
          "#state": "state",
          "#deployment": "deployment",
          "#image": "imageDigest",
        },
        ExpressionAttributeValues: marshall({
          ":revision": authority.boundaryRevision,
          ":state": "verified",
          ":image": authority.writerImageDigest,
        }),
      },
    },
  ];
}

export async function readRenewalRecord(
  key: string,
): Promise<Record<string, unknown> | undefined> {
  const result = await dynamoDbClient.send(
    new GetItemCommand({
      TableName: tableName("GuildSubscriptionTable"),
      Key: marshall({ guildId: key }),
      ConsistentRead: true,
    }),
  );
  return result.Item ? unmarshall(result.Item) : undefined;
}

async function transactRenewalRecords(
  items: ConstructorParameters<
    typeof TransactWriteItemsCommand
  >[0]["TransactItems"],
): Promise<boolean> {
  try {
    await dynamoDbClient.send(
      new TransactWriteItemsCommand({ TransactItems: items }),
    );
    return true;
  } catch (error) {
    if (
      error instanceof TransactionCanceledException &&
      error.CancellationReasons?.some(
        (reason) =>
          reason.Code === "ConditionalCheckFailed" ||
          reason.Code === "TransactionConflict",
      ) &&
      error.CancellationReasons.every(
        (reason) =>
          reason.Code === "None" ||
          reason.Code === "ConditionalCheckFailed" ||
          reason.Code === "TransactionConflict",
      )
    )
      return false;
    throw error;
  }
}

export async function claimRenewalOperation(
  operation: RenewalOperation,
  expected: GuildSubscription,
): Promise<boolean> {
  const table = tableName("GuildSubscriptionTable");
  const conditions = [
    "attribute_exists(guildId)",
    "#stripeSubscriptionId = :subscriptionId",
  ];
  const names: Record<string, string> = {
    "#stripeSubscriptionId": "stripeSubscriptionId",
    "#stripeSyncRevision": "stripeSyncRevision",
  };
  const values: Record<string, string> = {
    ":subscriptionId": operation.subscriptionId,
  };
  if (expected.stripeSyncRevision === undefined)
    conditions.push("attribute_not_exists(#stripeSyncRevision)");
  else {
    conditions.push("#stripeSyncRevision = :revision");
    values[":revision"] = expected.stripeSyncRevision;
  }
  return transactRenewalRecords([
    { ConditionCheck: renewalRecoveryFence(operation.guildId) },
    {
      ConditionCheck: {
        TableName: table,
        Key: marshall({ guildId: operation.guildId }),
        ConditionExpression: conditions.join(" AND "),
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: marshall(values),
      },
    },
    {
      ConditionCheck: historicalRevisionFence(
        billingChangeControlKey(operation.guildId),
        undefined,
      ),
    },
    {
      Put: {
        TableName: table,
        Item: marshall({
          ...operation,
          guildId: renewalOperationKey(
            operation.guildId,
            operation.operationId,
          ),
        }),
        ConditionExpression: "attribute_not_exists(guildId)",
      },
    },
    {
      Put: {
        TableName: table,
        Item: marshall({
          guildId: renewalControlKey(operation.guildId),
          operationId: operation.operationId,
          revision: operation.revision,
        }),
        ConditionExpression: "attribute_not_exists(guildId)",
      },
    },
  ]);
}

export async function writeRenewalOperation(
  next: RenewalOperation,
  expectedRevision: string,
): Promise<boolean> {
  const table = tableName("GuildSubscriptionTable");
  const control = {
    TableName: table,
    Key: marshall({ guildId: renewalControlKey(next.guildId) }),
    ConditionExpression: "operationId = :operationId",
    ExpressionAttributeValues: marshall({ ":operationId": next.operationId }),
  };
  return transactRenewalRecords([
    {
      Put: {
        TableName: table,
        Item: marshall({
          ...next,
          guildId: renewalOperationKey(next.guildId, next.operationId),
        }),
        ConditionExpression: "#revision = :revision",
        ExpressionAttributeNames: { "#revision": "revision" },
        ExpressionAttributeValues: marshall({ ":revision": expectedRevision }),
      },
    },
    isRenewalComplete(next) ? { Delete: control } : { ConditionCheck: control },
  ]);
}

export async function claimBillingChangeOperation(
  input: BillingChangeClaim,
): Promise<boolean> {
  const operation = input.operation;
  const usage = input.usage && parseChangeUsage(operation, input.usage);
  return transactRenewalRecords([
    { ConditionCheck: renewalRecoveryFence(operation.guildId) },
    {
      ConditionCheck: subscriptionRevisionFence(
        operation.guildId,
        input.expectedSubscription,
      ),
    },
    {
      ConditionCheck: historicalRevisionFence(
        renewalControlKey(operation.guildId),
        undefined,
      ),
    },
    {
      ConditionCheck: {
        TableName: tableName("GuildSubscriptionTable"),
        Key: marshall({ guildId: purchaseRecordKey(operation.guildId) }),
        ConditionExpression:
          "attribute_not_exists(#guildId) OR #state IN (:completed, :expired)",
        ExpressionAttributeNames: { "#guildId": "guildId", "#state": "state" },
        ExpressionAttributeValues: marshall({
          ":completed": "completed",
          ":expired": "expired",
        }),
      },
    },
    {
      Put: {
        TableName: tableName("GuildSubscriptionTable"),
        Item: marshall({
          ...operation,
          guildId: billingChangeOperationKey(
            operation.guildId,
            operation.operationId,
          ),
        }),
        ConditionExpression: "attribute_not_exists(guildId)",
      },
    },
    {
      Put: {
        TableName: tableName("GuildSubscriptionTable"),
        Item: marshall({
          guildId: billingChangeControlKey(operation.guildId),
          operationId: operation.operationId,
        }),
        ConditionExpression: "attribute_not_exists(guildId)",
      },
    },
    ...(usage
      ? [
          { Put: offerUsagePut(usage.next, usage.expected) },
          ...offerAuthorityFences(usage.authority),
        ]
      : []),
  ]);
}
export async function writeBillingChangeOperation(
  input: BillingChangeWrite,
): Promise<boolean> {
  const next = input.next;
  const usage = input.usage && parseChangeUsage(next, input.usage);
  const control = {
    TableName: tableName("GuildSubscriptionTable"),
    Key: marshall({ guildId: billingChangeControlKey(next.guildId) }),
    ConditionExpression: "operationId = :operationId",
    ExpressionAttributeValues: marshall({ ":operationId": next.operationId }),
  };
  return transactRenewalRecords([
    {
      Put: {
        TableName: tableName("GuildSubscriptionTable"),
        Item: marshall({
          ...next,
          guildId: billingChangeOperationKey(next.guildId, next.operationId),
        }),
        ConditionExpression: "#revision = :revision",
        ExpressionAttributeNames: { "#revision": "revision" },
        ExpressionAttributeValues: marshall({
          ":revision": input.expectedRevision,
        }),
      },
    },
    isBillingChangeComplete(next)
      ? { Delete: control }
      : { ConditionCheck: control },
    ...(usage ? [{ Put: offerUsagePut(usage.next, usage.expected) }] : []),
  ]);
}

export async function writeRenewalRecoveryRecord(input: {
  next: RenewalRecovery;
  expectedRevision?: string;
  expectedPointer?: RenewalRecoveryPointer;
  supersededWatch?: Extract<RenewalRecovery, { state: "watching" }>;
  expectedSubscription: GuildSubscription;
  blocking: boolean;
}): Promise<boolean> {
  const next = input.next;
  if (input.expectedSubscription.stripeSubscriptionId !== next.subscriptionId)
    return false;
  const table = tableName("GuildSubscriptionTable");
  const superseded = input.supersededWatch;
  const archived: NonNullable<Parameters<typeof transactRenewalRecords>[0]> =
    superseded
      ? [
          {
            Update: {
              TableName: table,
              Key: marshall({ guildId: renewalRecoveryKey(superseded) }),
              UpdateExpression:
                "SET #state = :ended, #revision = :newRevision REMOVE nextCheckAt, recoveryQueue, recoveryDueAt",
              ConditionExpression:
                "#revision = :revision AND #state = :watching AND enforcementAccepted = :no",
              ExpressionAttributeNames: {
                "#state": "state",
                "#revision": "revision",
              },
              ExpressionAttributeValues: marshall({
                ":ended": "ended",
                ":newRevision": randomUUID(),
                ":revision": superseded.revision,
                ":watching": "watching",
                ":no": false,
              }),
            },
          },
        ]
      : [];
  return transactRenewalRecords([
    ...archived,
    {
      ConditionCheck: subscriptionRevisionFence(
        next.guildId,
        input.expectedSubscription,
      ),
    },
    {
      Put: {
        TableName: table,
        Item: marshall(
          {
            ...next,
            ownerGuildId: next.guildId,
            guildId: renewalRecoveryKey(next),
            ...(renewalRecoveryNextCheck(next) !== undefined
              ? {
                  recoveryQueue: next.mode,
                  recoveryDueAt: renewalRecoveryNextCheck(next),
                }
              : {}),
          },
          { removeUndefinedValues: true },
        ),
        ConditionExpression: input.expectedRevision
          ? "#revision = :revision"
          : "attribute_not_exists(guildId)",
        ...(input.expectedRevision
          ? {
              ExpressionAttributeNames: { "#revision": "revision" },
              ExpressionAttributeValues: marshall({
                ":revision": input.expectedRevision,
              }),
            }
          : {}),
      },
    },
    {
      Put: {
        TableName: table,
        Item: marshall({
          guildId: renewalRecoveryCurrentKey(next.guildId),
          key: renewalRecoveryKey(next),
          revision: next.revision,
          blocking: input.blocking,
        }),
        ConditionExpression: input.expectedPointer
          ? "#revision = :revision"
          : "attribute_not_exists(guildId)",
        ...(input.expectedPointer
          ? {
              ExpressionAttributeNames: { "#revision": "revision" },
              ExpressionAttributeValues: marshall({
                ":revision": input.expectedPointer.revision,
              }),
            }
          : {}),
      },
    },
  ]);
}
function renewalRecoveryFence(guildId: string): ConditionCheck {
  return {
    TableName: tableName("GuildSubscriptionTable"),
    Key: marshall({ guildId: renewalRecoveryCurrentKey(guildId) }),
    ConditionExpression: "attribute_not_exists(guildId) OR #blocking = :no",
    ExpressionAttributeNames: { "#blocking": "blocking" },
    ExpressionAttributeValues: marshall({ ":no": false }),
  };
}
export async function listDueRenewalRecoveries(input: {
  mode: "test" | "live";
  now: number;
  limit: number;
  cursor?: string;
}): Promise<{ keys: string[]; cursor?: string }> {
  const cursor = readRenewalRecoveryCursor(input.cursor);
  if (cursor && cursor.recoveryQueue !== input.mode)
    throw new Error("Renewal cursor mode mismatch");
  const response = await dynamoDbClient.send(
    new QueryCommand({
      TableName: tableName("GuildSubscriptionTable"),
      IndexName: RENEWAL_RECOVERY_DUE_INDEX,
      KeyConditionExpression: "recoveryQueue = :mode AND recoveryDueAt <= :now",
      ExpressionAttributeValues: marshall({
        ":mode": input.mode,
        ":now": input.now,
      }),
      Limit: input.limit,
      ...(cursor ? { ExclusiveStartKey: marshall(cursor) } : {}),
    }),
  );
  return {
    keys: (response.Items ?? []).map((item) =>
      z.string().parse(unmarshall(item).guildId),
    ),
    ...(response.LastEvaluatedKey
      ? {
          cursor: writeRenewalRecoveryCursor(
            renewalRecoveryCursorSchema.parse(
              unmarshall(response.LastEvaluatedKey),
            ),
          ),
        }
      : {}),
  };
}

export async function getMeetingHistoryTimestampPage(
  guildId: string,
  options: MeetingBrowsePageOptions,
): Promise<MeetingBrowsePage<MeetingHistory>> {
  options.signal?.throwIfAborted();
  if (!Number.isInteger(options.limit) || options.limit <= 0)
    throw new Error("Page limit must be a positive integer");
  const result = await dynamoDbClient.send(
    new QueryCommand({
      TableName: tableName("MeetingHistoryTable"),
      IndexName: "GuildTimestampIndex",
      KeyConditionExpression:
        "guildId = :guildId AND #timestamp BETWEEN :start AND :end",
      ExpressionAttributeNames: { "#timestamp": "timestamp" },
      ExpressionAttributeValues: marshall({
        ":guildId": guildId,
        ":start": options.startTimestamp,
        ":end": options.endTimestamp,
      }),
      Limit: options.limit,
      ExclusiveStartKey: options.cursor,
      ScanIndexForward: false,
    }),
    { abortSignal: options.signal },
  );
  options.signal?.throwIfAborted();
  return {
    items: (result.Items ?? []).map((item) => ({
      record: unmarshall(item) as MeetingHistory,
      cursorAfter: {
        guildId: item.guildId,
        timestamp: item.timestamp,
        channelId_timestamp: item.channelId_timestamp,
      },
    })),
    nextCursor: result.LastEvaluatedKey,
  };
}
export async function getMeetingUserIndexTimestampPage(
  principal: string,
  options: MeetingBrowsePageOptions,
): Promise<MeetingBrowsePage<MeetingUserIndexRecord>> {
  options.signal?.throwIfAborted();
  if (!Number.isInteger(options.limit) || options.limit <= 0)
    throw new Error("Page limit must be a positive integer");
  const result = await dynamoDbClient.send(
    new QueryCommand({
      TableName: tableName("MeetingUserIndexTable"),
      KeyConditionExpression:
        "userId = :userId AND userTimestamp BETWEEN :start AND :end",
      ExpressionAttributeValues: marshall({
        ":userId": principal,
        ":start": `${options.startTimestamp}#`,
        ":end": `${options.endTimestamp}#\uffff`,
      }),
      Limit: options.limit,
      ExclusiveStartKey: options.cursor,
      ScanIndexForward: false,
    }),
    { abortSignal: options.signal },
  );
  options.signal?.throwIfAborted();
  return {
    items: (result.Items ?? []).map((item) => ({
      record: unmarshall(item) as MeetingUserIndexRecord,
      cursorAfter: { userId: item.userId, userTimestamp: item.userTimestamp },
    })),
    nextCursor: result.LastEvaluatedKey,
  };
}
