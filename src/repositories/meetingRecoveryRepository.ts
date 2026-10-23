import { publicationHistoryAfterPatch } from "./meetingHistoryTransitionState";
import {
  publicationSnapshot,
  publicationSnapshotCondition,
  settledLifecycleDelivery,
} from "../types/meetingPublication";
import {
  DynamoDBClient,
  GetItemCommand,
  ScanCommand,
  TransactWriteItemsCommand,
  UpdateItemCommand,
} from "@aws-sdk/client-dynamodb";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import type { ActiveMeetingLease, MeetingHistory } from "../types/db";
import type {
  RecoveryClaim,
  RecoveryClaimInput,
  RecoveryRepository,
  RecoveryTables,
  RecoveryLease,
} from "../types/meetingRecovery";
import type {
  DeploymentControlRecord,
  HistoryKey,
} from "../types/deploymentControl";
import { buildRuntimeAdmissionChecks } from "../services/deploymentControlTransactions";
import {
  recoveryDispositionSchema,
  recoveryExportSchema,
  captureCoverageSummarySchema,
  recordingCaptureStateSchema,
  checkpointObjectSchema,
} from "../types/recordingCheckpoint";

import { notesDeliveryTimingSchema } from "../types/meetingNotesTiming";

const LEASE_SECONDS = 30;
const SCAN_PAGE_SIZE = 100;
const OBSERVED_FIELDS = [
  "meetingId",
  "ownerInstanceId",
  "executionVersion",
  "status",
  "checkpoint",
  "capture",
  "captureCoverage",
  "recovery",
  "processing",
  "delivery",
  "transcriptS3Key",
  "recoveryTranscript",
  "recoveryExport",
  "updatedAt",
  "completionPolicy",
  "cancellationReason",
  "endReason",
  "notes",
  "summarySentence",
  "summaryLabel",
  "summaryMessageId",
  "notesMessageIds",
  "notesChannelId",
  "notesDeliveryTiming",
] as const;
function fieldsSnapshot(record: object, fields: readonly string[]) {
  const entries = Object.entries(record);
  const names: Record<string, string> = {};
  const values: Record<string, unknown> = {};
  const clauses = fields.map((field, i) => {
    const key = `#o${i}`;
    names[key] = field;
    const value = entries.find(([name]) => name === field)?.[1];
    if (value === undefined) return `attribute_not_exists(${key})`;
    values[`:o${i}`] = value;
    return `${key} = :o${i}`;
  });
  return {
    ConditionExpression: clauses.join(" AND "),
    ExpressionAttributeNames: names,
    ...(Object.keys(values).length
      ? {
          ExpressionAttributeValues: marshall(values, {
            removeUndefinedValues: true,
          }),
        }
      : {}),
  };
}
function historyKey(history: MeetingHistory): HistoryKey {
  return {
    guildId: history.guildId,
    channelId_timestamp: history.channelId_timestamp,
  };
}
function hasRecoveryWork(row: MeetingHistory) {
  const recovery = row.recovery;
  return (
    Boolean(
      row.checkpoint &&
      ["starting", "in_progress", "processing"].includes(row.status ?? ""),
    ) ||
    Boolean(
      recovery &&
      ["pending", "claimed", "failed"].includes(recovery.disposition),
    )
  );
}
function exportAcknowledged(row: MeetingHistory) {
  return (
    row.recovery?.stage === "export" &&
    ["acknowledged", "skipped"].includes(row.recoveryExport?.state ?? "")
  );
}
function reconcilesWithoutAnotherAttempt(row: MeetingHistory) {
  return row.recovery?.stage === "delivery" || exportAcknowledged(row);
}
function publicationOwnerRetained(row: MeetingHistory): boolean {
  return (
    row.publicationRepair?.kind === "running" ||
    Boolean(row.updateDelivery && "attempt" in row.updateDelivery.progress)
  );
}
function hasEligibleOriginalOwner(row: MeetingHistory): boolean {
  return Boolean(
    row.ownerInstanceId &&
    row.executionVersion &&
    row.status !== "cancelled" &&
    row.completionPolicy?.decision !== "cancel" &&
    !publicationOwnerRetained(row),
  );
}
export function isRecordingRecoveryCandidate(
  row: MeetingHistory,
  now: number,
): boolean {
  if (!hasEligibleOriginalOwner(row)) return false;
  const recovery = row.recovery;
  if (recovery?.disposition === "needs_reconciliation")
    return recovery.reason === "delivery_uncertain" || exportAcknowledged(row);
  if (recovery?.disposition === "done") return false;
  if (exportAcknowledged(row)) return true;
  if ((recovery?.attempt ?? 0) >= 4) return false;
  if (
    recovery?.retry.nextAttemptAt &&
    Date.parse(recovery.retry.nextAttemptAt) > now * 1000
  )
    return false;
  return hasRecoveryWork(row);
}
export function prepareRecoveryClaim(
  input: RecoveryClaimInput,
): RecoveryClaim | undefined {
  const { history, lease, context, attemptId } = input;
  if (!attemptId || !isRecordingRecoveryCandidate(history, context.now))
    return undefined;
  if (
    lease &&
    (lease.leaseExpiresAt >= context.now ||
      lease.meetingId !== history.meetingId ||
      lease.ownerInstanceId !== history.ownerInstanceId ||
      lease.executionVersion !== history.executionVersion)
  )
    return undefined;

  const version = history.executionVersion! + 1;
  const now = new Date(context.now * 1000).toISOString();
  const recovery = recoveryDispositionSchema.parse({
    ...(history.recovery?.stage === "delivery"
      ? { disposition: "needs_reconciliation", reason: "delivery_uncertain" }
      : { disposition: "claimed" }),
    executionVersion: version,
    attempt: reconcilesWithoutAnotherAttempt(history)
      ? history.recovery!.attempt
      : (history.recovery?.attempt ?? 0) + 1,
    stage: history.recovery?.stage ?? "verification",
    retry: { maxAttempts: 4, nextAttemptAt: null },
  });
  return {
    history: {
      ...history,
      ownerInstanceId: context.instanceId,
      executionVersion: version,
      recovery,
      updatedAt: now,
    },
    lease: {
      sessionMode: "recovery",
      recoveryAttemptId: attemptId,
      executionVersion: version,
      guildId: history.guildId,
      meetingId: history.meetingId,
      ownerInstanceId: context.instanceId,
      voiceChannelId: history.channelId,
      textChannelId: history.notesChannelId ?? history.channelId,
      isAutoRecording: Boolean(history.isAutoRecording),
      status: "processing",
      leaseExpiresAt: context.now + LEASE_SECONDS,
      createdAt: now,
      updatedAt: now,
      expiresAt: context.now + LEASE_SECONDS + 120,
    },
  };
}
function ownedLeaseCondition(claim: RecoveryClaim, now: number) {
  return {
    ConditionExpression:
      "sessionMode = :mode AND recoveryAttemptId = :attempt AND meetingId = :meeting AND ownerInstanceId = :owner AND executionVersion = :version AND leaseExpiresAt >= :now",
    ExpressionAttributeValues: marshall({
      ":mode": "recovery",
      ":attempt": claim.lease.recoveryAttemptId,
      ":meeting": claim.lease.meetingId,
      ":owner": claim.lease.ownerInstanceId,
      ":version": claim.lease.executionVersion,
      ":now": now,
    }),
  };
}
function updateHistory(
  history: MeetingHistory,
  patch: object,
  tables: RecoveryTables,
) {
  const snapshot = fieldsSnapshot(history, OBSERVED_FIELDS);
  const publication = publicationSnapshotCondition(
    publicationSnapshot(history),
  );
  snapshot.ConditionExpression += " AND " + publication.condition;
  Object.assign(snapshot.ExpressionAttributeNames, publication.names);
  snapshot.ExpressionAttributeValues = {
    ...snapshot.ExpressionAttributeValues,
    ...marshall(publication.values, { removeUndefinedValues: true }),
  };
  const settled = settledLifecycleDelivery(publicationSnapshot(history), patch);
  if (settled)
    patch = {
      ...patch,
      updateDelivery: settled.delivery,
      ...(settled.dueAt === undefined
        ? {}
        : {
            updateDeliveryQueue: "meeting-update:v1",
            updateDeliveryDueAt: settled.dueAt,
          }),
    };
  const names = snapshot.ExpressionAttributeNames;
  const values = snapshot.ExpressionAttributeValues ?? {};
  const changes = Object.entries(patch)
    .filter(([, value]) => value !== undefined)
    .map(([key, value], i) => {
      names[`#p${i}`] = key;
      Object.assign(
        values,
        marshall({ [`:p${i}`]: value }, { removeUndefinedValues: true }),
      );
      return `#p${i} = :p${i}`;
    });
  return {
    TableName: tables.meetingHistory,
    Key: marshall(historyKey(history)),
    ...snapshot,
    ExpressionAttributeValues: values,
    UpdateExpression: `SET ${changes.join(", ")}`,
  };
}
type RecoveryPatch = Parameters<
  RecoveryRepository["updateRecordingRecovery"]
>[1];
const stages = ["verification", "transcription", "notes", "delivery", "export"];
function validateRecoveryNotesTiming(
  claim: RecoveryClaim,
  patch: RecoveryPatch,
) {
  if (patch.notesDeliveryTiming !== undefined) {
    const next = notesDeliveryTimingSchema.parse(patch.notesDeliveryTiming);
    const prior = notesDeliveryTimingSchema.safeParse(
      claim.history.notesDeliveryTiming,
    );
    if (
      prior.success &&
      (next.firstAcknowledgedAt !== prior.data.firstAcknowledgedAt ||
        next.path !== prior.data.path ||
        (prior.data.kind === "complete" &&
          (next.kind !== "complete" ||
            next.completeAcknowledgedAt !== prior.data.completeAcknowledgedAt)))
    )
      throw new Error("Acknowledged notes timing cannot be replaced");
  }
}
function validateRecoveryPatch(claim: RecoveryClaim, patch: RecoveryPatch) {
  validateRecoveryNotesTiming(claim, patch);
  if (patch.captureCoverage)
    captureCoverageSummarySchema.parse(patch.captureCoverage);
  if (patch.recovery) {
    const next = recoveryDispositionSchema.parse(patch.recovery);
    const prior = claim.history.recovery!;
    if (
      next.executionVersion !== claim.lease.executionVersion ||
      next.attempt !== prior.attempt ||
      next.retry.maxAttempts !== 4 ||
      stages.indexOf(next.stage) < stages.indexOf(prior.stage)
    )
      throw new Error("Recovery stage identity or ordering changed");
  }
  if (patch.capture) {
    recordingCaptureStateSchema.parse(patch.capture);
    const original = claim.history.capture;
    if (
      original &&
      ["complete", "interrupted"].includes(original.kind) &&
      JSON.stringify(original) !== JSON.stringify(patch.capture)
    )
      throw new Error("Terminal capture cannot be relabeled");
  }
  validateRecoveryTranscriptReceipt(claim, patch);
  validateRecoveryExportReceipt(claim, patch);
  if (
    patch.status &&
    !["processing", "complete", "interrupted"].includes(patch.status)
  )
    throw new Error("Invalid recovery status transition");
}
function validateRecoveryExportReceipt(
  claim: RecoveryClaim,
  patch: RecoveryPatch,
) {
  if (patch.recoveryExport) {
    const receipt = recoveryExportSchema.parse(patch.recoveryExport);
    const prior = claim.history.recoveryExport;
    if (
      receipt.checkpointRevision !== claim.history.checkpoint?.revision ||
      receipt.intentExecutionVersion !==
        (prior?.intentExecutionVersion ?? claim.lease.executionVersion) ||
      (prior && receipt.state === "pending" && prior.state !== "pending")
    )
      throw new Error("Recovery export identity or submission fence changed");
  }
}
function validateRecoveryTranscriptReceipt(
  claim: RecoveryClaim,
  patch: RecoveryPatch,
) {
  if (patch.recoveryTranscript) {
    const receipt = patch.recoveryTranscript;
    checkpointObjectSchema.parse(receipt.object);
    if (
      receipt.checkpointRevision !== claim.history.checkpoint?.revision ||
      receipt.object.key !== patch.transcriptS3Key ||
      !receipt.object.key.startsWith(
        `${claim.history.checkpoint.artifactFolder}recovery/`,
      )
    )
      throw new Error(
        "Recovered transcript receipt is not bound to checkpoint",
      );
  }
}
async function conditionally(run: () => Promise<unknown>): Promise<boolean> {
  try {
    await run();
    return true;
  } catch (error) {
    const failure = z
      .object({
        name: z.string(),
        CancellationReasons: z
          .array(z.object({ Code: z.string().optional() }))
          .optional(),
      })
      .safeParse(error);
    if (
      failure.success &&
      (failure.data.name === "ConditionalCheckFailedException" ||
        (failure.data.name === "TransactionCanceledException" &&
          failure.data.CancellationReasons?.some(
            (row) => row.Code === "ConditionalCheckFailed",
          )))
    )
      return false;
    throw error;
  }
}
export function createDynamoRecoveryRepository(
  client: DynamoDBClient,
  tables: RecoveryTables,
): RecoveryRepository {
  async function get<T>(table: string, key: object): Promise<T | undefined> {
    const result = await client.send(
      new GetItemCommand({
        TableName: table,
        Key: marshall(key),
        ConsistentRead: true,
      }),
    );
    return result.Item ? (unmarshall(result.Item) as T) : undefined;
  }
  return {
    getRecoveryLease: (guildId) =>
      get<ActiveMeetingLease>(tables.activeMeeting, { guildId }),
    async discoverRecordingRecoveries(cursor) {
      const page = await client.send(
        new ScanCommand({
          TableName: tables.meetingHistory,
          Limit: SCAN_PAGE_SIZE,
          ExclusiveStartKey: cursor ? marshall(cursor) : undefined,
          ProjectionExpression:
            "guildId, channelId_timestamp, meetingId, ownerInstanceId, executionVersion, #status, checkpoint, recovery, recoveryExport, completionPolicy",
          ExpressionAttributeNames: { "#status": "status" },
          ConsistentRead: true,
        }),
      );
      const rows = (page.Items ?? []).map(
        (item) => unmarshall(item) as MeetingHistory,
      );
      return {
        keys: rows
          .filter((row) =>
            isRecordingRecoveryCandidate(row, Math.floor(Date.now() / 1000)),
          )
          .map(historyKey),
        cursor: page.LastEvaluatedKey
          ? (unmarshall(page.LastEvaluatedKey) as HistoryKey)
          : undefined,
      };
    },
    async claimRecordingRecovery(input) {
      const next = prepareRecoveryClaim(input);
      if (!next) return undefined;
      const leaseCondition = input.lease
        ? fieldsSnapshot(input.lease, [
            ...Object.keys(input.lease),
            "recoveryAttemptId",
            "voiceOperationAttemptId",
          ])
        : { ConditionExpression: "attribute_not_exists(guildId)" };
      const success = await conditionally(() =>
        client.send(
          new TransactWriteItemsCommand({
            ClientRequestToken: input.attemptId,
            TransactItems: [
              ...buildRuntimeAdmissionChecks(input.context, tables),
              {
                Put: {
                  TableName: tables.activeMeeting,
                  Item: marshall(next.lease),
                  ...leaseCondition,
                },
              },
              {
                Update: updateHistory(
                  input.history,
                  {
                    ownerInstanceId: next.history.ownerInstanceId,
                    executionVersion: next.history.executionVersion,
                    recovery: next.history.recovery,
                    updatedAt: next.history.updatedAt,
                  },
                  tables,
                ),
              },
            ],
          }),
        ),
      );
      return success ? next : undefined;
    },
    async renewRecordingRecovery(claim, now) {
      const lease: RecoveryLease = {
        ...claim.lease,
        leaseExpiresAt: now + LEASE_SECONDS,
        updatedAt: new Date(now * 1000).toISOString(),
        expiresAt: now + LEASE_SECONDS + 120,
      };
      const proof = ownedLeaseCondition(claim, now);
      const success = await conditionally(() =>
        client.send(
          new UpdateItemCommand({
            TableName: tables.activeMeeting,
            Key: marshall({ guildId: lease.guildId }),
            ...proof,
            UpdateExpression:
              "SET leaseExpiresAt = :expiry, updatedAt = :updated, expiresAt = :ttl",
            ExpressionAttributeValues: {
              ...proof.ExpressionAttributeValues,
              ...marshall({
                ":expiry": lease.leaseExpiresAt,
                ":updated": lease.updatedAt,
                ":ttl": lease.expiresAt,
              }),
            },
          }),
        ),
      );
      return success ? lease : undefined;
    },
    async updateRecordingRecovery(claim, patch, now) {
      validateRecoveryPatch(claim, patch);
      const success = await conditionally(() =>
        client.send(
          new TransactWriteItemsCommand({
            TransactItems: [
              {
                ConditionCheck: {
                  TableName: tables.activeMeeting,
                  Key: marshall({ guildId: claim.lease.guildId }),
                  ...ownedLeaseCondition(claim, now),
                },
              },
              { Update: updateHistory(claim.history, patch, tables) },
            ],
          }),
        ),
      );
      if (!success) return undefined;
      return publicationHistoryAfterPatch(claim.history, patch);
    },
    async releaseRecordingRecovery(claim, now) {
      return conditionally(() =>
        client.send(
          new TransactWriteItemsCommand({
            TransactItems: [
              {
                Delete: {
                  TableName: tables.activeMeeting,
                  Key: marshall({ guildId: claim.lease.guildId }),
                  ...ownedLeaseCondition(claim, now),
                },
              },
              {
                ConditionCheck: {
                  TableName: tables.meetingHistory,
                  Key: marshall(historyKey(claim.history)),
                  ...fieldsSnapshot(claim.history, OBSERVED_FIELDS),
                },
              },
            ],
          }),
        ),
      );
    },
    async saveRecoveryCursor(context, previous, next) {
      const checks = buildRuntimeAdmissionChecks(context, tables);
      const control = checks[0].ConditionCheck!;
      const snapshot = fieldsSnapshot({ recoveryScanCursor: previous }, [
        "recoveryScanCursor",
      ]);
      return conditionally(() =>
        client.send(
          new TransactWriteItemsCommand({
            TransactItems: [
              {
                Update: {
                  ...control,
                  ConditionExpression: `${control.ConditionExpression} AND ${snapshot.ConditionExpression} AND coordinatorEpoch = :scanEpoch`,
                  ExpressionAttributeNames: {
                    ...control.ExpressionAttributeNames,
                    ...snapshot.ExpressionAttributeNames,
                  },
                  ExpressionAttributeValues: {
                    ...control.ExpressionAttributeValues,
                    ...snapshot.ExpressionAttributeValues,
                    ...marshall({ ":scanEpoch": context.observedEpoch }),
                    ...(next ? marshall({ ":cursor": next }) : {}),
                  },
                  UpdateExpression: next
                    ? "SET recoveryScanCursor = :cursor"
                    : "REMOVE recoveryScanCursor",
                },
              },
              checks[1],
            ],
          }),
        ),
      );
    },
  };
}
export function createMockRecoveryRepository(
  records: Map<string, DeploymentControlRecord>,
  histories: Map<string, MeetingHistory[]>,
  leases: Map<string, ActiveMeetingLease>,
  admitted: (input: RecoveryClaimInput["context"]) => boolean,
): RecoveryRepository {
  const get = (row: HistoryKey) =>
    histories
      .get(row.guildId)
      ?.find((item) => item.channelId_timestamp === row.channelId_timestamp);
  const same = (a: object | undefined, b: object | undefined) =>
    isDeepStrictEqual(
      a === undefined ? a : JSON.parse(JSON.stringify(a)),
      b === undefined ? b : JSON.parse(JSON.stringify(b)),
    );
  const owned = (claim: RecoveryClaim, now: number) => {
    const lease = leases.get(claim.lease.guildId);
    return (
      lease?.sessionMode === "recovery" &&
      lease.recoveryAttemptId === claim.lease.recoveryAttemptId &&
      lease.meetingId === claim.lease.meetingId &&
      lease.executionVersion === claim.lease.executionVersion &&
      lease.ownerInstanceId === claim.lease.ownerInstanceId &&
      lease.leaseExpiresAt >= now
    );
  };
  return {
    getRecoveryLease: async (guildId) => structuredClone(leases.get(guildId)),
    async discoverRecordingRecoveries(cursor) {
      const rows = [...histories.values()]
        .flat()
        .sort((a, b) =>
          JSON.stringify(historyKey(a)).localeCompare(
            JSON.stringify(historyKey(b)),
          ),
        );
      const index = cursor
        ? rows.findIndex((row) => same(historyKey(row), cursor)) + 1
        : 0;
      const page = rows.slice(index, index + SCAN_PAGE_SIZE);
      return {
        keys: page
          .filter((row) =>
            isRecordingRecoveryCandidate(row, Math.floor(Date.now() / 1000)),
          )
          .map(historyKey),
        cursor:
          index + SCAN_PAGE_SIZE < rows.length
            ? historyKey(page[page.length - 1])
            : undefined,
      };
    },
    async claimRecordingRecovery(input) {
      const next = prepareRecoveryClaim(input);
      if (
        !next ||
        !admitted(input.context) ||
        !same(get(input.history), input.history) ||
        !same(leases.get(input.history.guildId), input.lease)
      )
        return undefined;
      Object.assign(get(input.history)!, structuredClone(next.history));
      leases.set(next.lease.guildId, structuredClone(next.lease));
      return structuredClone(next);
    },
    async renewRecordingRecovery(claim, now) {
      if (!owned(claim, now)) return undefined;
      const lease = {
        ...claim.lease,
        leaseExpiresAt: now + LEASE_SECONDS,
        updatedAt: new Date(now * 1000).toISOString(),
        expiresAt: now + LEASE_SECONDS + 120,
      };
      leases.set(lease.guildId, lease);
      return structuredClone(lease);
    },
    async updateRecordingRecovery(claim, patch, now) {
      if (!owned(claim, now) || !same(get(claim.history), claim.history))
        return undefined;
      validateRecoveryPatch(claim, patch);
      const next = publicationHistoryAfterPatch(claim.history, patch);
      Object.assign(get(claim.history)!, structuredClone(next));
      return structuredClone(next);
    },
    async releaseRecordingRecovery(claim, now) {
      if (!owned(claim, now) || !same(get(claim.history), claim.history))
        return false;
      leases.delete(claim.lease.guildId);
      return true;
    },
    async saveRecoveryCursor(context, previous, next) {
      const control = [...records.values()].find(
        (row) => row.recordType === "control",
      );
      if (
        !control ||
        control.recordType !== "control" ||
        !admitted(context) ||
        control.coordinatorEpoch !== context.observedEpoch ||
        !same(control.recoveryScanCursor, previous)
      )
        return false;
      control.recoveryScanCursor = next;
      return true;
    },
  };
}
