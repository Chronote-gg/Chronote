import {
  type DynamoDBClient,
  GetItemCommand,
  ScanCommand,
  type ScanCommandInput,
  TransactWriteItemsCommand,
  UpdateItemCommand,
  type UpdateItemCommandInput,
} from "@aws-sdk/client-dynamodb";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";
import { isDeepStrictEqual } from "node:util";
import { LIFECYCLE } from "../services/lifecycleTiming";
import type {
  ActiveMeetingLease,
  FinishState,
  MeetingHistory,
} from "../types/db";
import { completionPolicySchema } from "../types/meetingCompletionPolicy";
import { MEETING_STATUS, type MeetingStatus } from "../types/meetingLifecycle";
import type {
  HistoryKey,
  SessionReservation,
} from "../types/meetingHistoryTransition";
import { TRANSCRIPTION_FAILED } from "../utils/meetingProcessing";
import { classifyDeploymentTransactionError } from "./deploymentControlErrors";
import { config } from "../services/configService";
import { dynamoDbClient, tableName } from "./dynamoClient";
import { getMockStore } from "./mockStore";

export type { FinishState };

export type FinisherRow = Pick<
  MeetingHistory,
  | "guildId"
  | "channelId_timestamp"
  | "meetingId"
  | "status"
  | "timestamp"
  | "updatedAt"
  | "lifecycleVersion"
  | "finish"
  | "ownerInstanceId"
>;
export type FinishClaim = {
  key: HistoryKey;
  meetingId: string;
  owner: string;
  history: MeetingHistory;
};
/**
 * The completion policy rides on the capture-end write, which only the lease
 * holder makes and only while the row is live, so it is set once; every other
 * writer still needs the transition validator's original-owner proof.
 */
type CaptureEndPatch = Pick<
  MeetingHistory,
  | "capture"
  | "endReason"
  | "endTriggeredByUserId"
  | "duration"
  | "completionPolicy"
  | "cancellationReason"
>;
type DerivedCaptureEnd = Pick<
  MeetingHistory,
  "capture" | "endReason" | "duration"
>;
type RetrySchedule = Pick<
  FinishState,
  "attempts" | "nextAttemptAt" | "phase" | "deliverSince"
>;
/** Rows that predate the lifecycle marker are claimed or adopted only by an operator. */
type ClaimOptions = { operator?: boolean };

export type MeetingFinishRepository = {
  scan(signal: AbortSignal): AsyncIterable<FinisherRow>;
  recordCaptureEnd(input: {
    reservation: SessionReservation;
    patch: CaptureEndPatch;
    claimOwner?: string;
    now: number;
  }): Promise<boolean>;
  claim(
    row: FinisherRow,
    owner: string,
    now: number,
    options?: ClaimOptions,
  ): Promise<FinishClaim | undefined>;
  adopt(
    row: FinisherRow,
    owner: string,
    derived: DerivedCaptureEnd,
    now: number,
    options?: ClaimOptions,
  ): Promise<FinishClaim | undefined>;
  /** Consistent read of the whole row. */
  read(key: HistoryKey): Promise<MeetingHistory | undefined>;
  renew(claim: FinishClaim, now: number): Promise<boolean>;
  save(
    claim: FinishClaim,
    patch: Partial<MeetingHistory>,
    now: number,
    expectedStatus?: MeetingStatus,
    /** Refuses the write when any field named here differs on the row, including absence. */
    unchanged?: UnchangedFields,
    /** Attributes the same write deletes: only a leftover recovery value. */
    remove?: readonly "recovery"[],
  ): Promise<MeetingHistory | undefined>;
  releaseDone(claim: FinishClaim): Promise<void>;
  releaseForRetry(claim: FinishClaim, next: RetrySchedule): Promise<void>;
  releaseUnclaimed(claim: FinishClaim): Promise<void>;
  abandon(row: FinisherRow, now: number): Promise<boolean>;
  listStranded(signal: AbortSignal): AsyncIterable<MeetingHistory>;
  /**
   * Puts an unmarked row back as `before` was, for an operator attempt that
   * could not finish it: removes the finish map and restores every field that
   * adoption and the steps before the terminal save write. Refused once the
   * row is terminal, carries the marker, or another owner holds the claim.
   */
  restoreStranded(claim: FinishClaim, before: MeetingHistory): Promise<boolean>;
};
/** A field named here with an undefined value requires the row to lack it. */
export type UnchangedFields = Partial<
  Pick<MeetingHistory, "updateDelivery" | "contentRevision">
>;
export type MeetingFinishTables = {
  meetingHistory: string;
  activeMeeting: string;
};

const MS_PER_SECOND = 1000;
const LIFECYCLE_VERSION = 2;
const LIVE_STATUSES: readonly MeetingStatus[] = [
  MEETING_STATUS.STARTING,
  MEETING_STATUS.IN_PROGRESS,
];
/** Statuses that are not terminal: a meeting in one of these still needs finishing. */
const OPEN_STATUSES: readonly MeetingStatus[] = [
  ...LIVE_STATUSES,
  MEETING_STATUS.PROCESSING,
];
const STRANDED_RESTORED_FIELDS = [
  "status",
  "capture",
  "endReason",
  "duration",
  "updatedAt",
  "transcriptS3Key",
  "chatS3Key",
  "finish",
] as const satisfies readonly (keyof MeetingHistory)[];
const FINISHER_ROW_FIELDS = [
  "guildId",
  "channelId_timestamp",
  "meetingId",
  "status",
  "timestamp",
  "updatedAt",
  "lifecycleVersion",
  "finish",
  "ownerInstanceId",
] as const satisfies readonly (keyof FinisherRow)[];

const isoAt = (now: number) => new Date(now * MS_PER_SECOND).toISOString();
const keyOf = (row: HistoryKey): HistoryKey => ({
  guildId: row.guildId,
  channelId_timestamp: row.channelId_timestamp,
});
const isOpen = (status: MeetingStatus | undefined) =>
  status !== undefined && OPEN_STATUSES.includes(status);
const isLive = (status: MeetingStatus | undefined) =>
  status !== undefined && LIVE_STATUSES.includes(status);

function defined<T extends object>(fields: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(fields).filter(([, value]) => value !== undefined),
  ) as Partial<T>;
}

function claimedFinish(
  previous: FinishState | undefined,
  owner: string,
  now: number,
): FinishState {
  return {
    ...defined({ deliverSince: previous?.deliverSince }),
    owner,
    expiresAt: now + LIFECYCLE.finishClaimSeconds,
    attempts: previous?.attempts ?? 0,
    startedAt: now,
    phase: previous?.phase ?? "process",
  };
}

function retryFinish(next: RetrySchedule): FinishState {
  return {
    ...defined({
      nextAttemptAt: next.nextAttemptAt,
      deliverSince: next.deliverSince,
    }),
    attempts: next.attempts,
    phase: next.phase,
  };
}

function captureEndFields(
  patch: CaptureEndPatch,
  claimOwner: string | undefined,
  now: number,
): Partial<MeetingHistory> {
  if (patch.completionPolicy)
    completionPolicySchema.parse(patch.completionPolicy);
  return {
    ...defined(patch),
    status: MEETING_STATUS.PROCESSING,
    updatedAt: isoAt(now),
    ...(claimOwner
      ? { finish: claimedFinish(undefined, claimOwner, now) }
      : {}),
  };
}

/** A retry whose earlier write committed with a lost response finds its own claim on the row. */
function alreadyRecorded(
  row: MeetingHistory,
  reservation: Pick<SessionReservation, "meetingId" | "ownerInstanceId">,
  claimOwner: string,
): boolean {
  return (
    row.meetingId === reservation.meetingId &&
    row.ownerInstanceId === reservation.ownerInstanceId &&
    row.status === MEETING_STATUS.PROCESSING &&
    row.finish?.owner === claimOwner
  );
}

function adoptedFields(
  row: FinisherRow,
  owner: string,
  derived: DerivedCaptureEnd,
  now: number,
): Partial<MeetingHistory> {
  return {
    ...defined(derived),
    status: MEETING_STATUS.PROCESSING,
    updatedAt: isoAt(now),
    finish: claimedFinish(row.finish, owner, now),
  };
}

/**
 * Key attributes are never rewritten, and an empty patch still bumps `updatedAt`
 * so the conditional write that proves the claim always has something to set.
 */
function savedFields(
  patch: Partial<MeetingHistory>,
  now: number,
): Partial<MeetingHistory> {
  const fields = defined({
    ...patch,
    guildId: undefined,
    channelId_timestamp: undefined,
  });
  return Object.keys(fields).length ? fields : { updatedAt: isoAt(now) };
}

function claimFor(
  row: Pick<FinisherRow, "meetingId"> & HistoryKey,
  owner: string,
  history: MeetingHistory,
): FinishClaim {
  return { key: keyOf(row), meetingId: row.meetingId, owner, history };
}

async function unlessStale<T>(write: () => Promise<T>): Promise<T | undefined> {
  try {
    return await write();
  } catch (error) {
    if (classifyDeploymentTransactionError(error) === "stale") return undefined;
    throw error;
  }
}

/**
 * Builds condition and update expressions with one shared name and value map.
 * Every attribute goes through a name alias because `finish`, `owner`, `status`
 * and `timestamp` are all DynamoDB reserved words.
 */
class Expression {
  readonly names: Record<string, string> = {};
  readonly values: Record<string, unknown> = {};
  private nextValue = 0;
  path(...segments: string[]) {
    return segments
      .map((segment) => {
        this.names[`#${segment}`] = segment;
        return `#${segment}`;
      })
      .join(".");
  }
  value(value: unknown) {
    const alias = `:v${this.nextValue++}`;
    this.values[alias] = value;
    return alias;
  }
  list(values: readonly unknown[]) {
    return values.map((value) => this.value(value)).join(", ");
  }
  assignments(fields: Partial<MeetingHistory>) {
    return Object.entries(defined(fields))
      .map(([field, value]) => `${this.path(field)} = ${this.value(value)}`)
      .join(", ");
  }
  attributes() {
    return {
      ExpressionAttributeNames: this.names,
      ...(Object.keys(this.values).length
        ? {
            ExpressionAttributeValues: marshall(this.values, {
              removeUndefinedValues: true,
            }),
          }
        : {}),
    };
  }
}

function versionCondition(e: Expression, options: ClaimOptions | undefined) {
  const lifecycleVersion = e.path("lifecycleVersion");
  return options?.operator
    ? `attribute_not_exists(${lifecycleVersion})`
    : `${lifecycleVersion} = ${e.value(LIFECYCLE_VERSION)}`;
}
const markedAs = (row: MeetingHistory, options: ClaimOptions | undefined) =>
  options?.operator
    ? row.lifecycleVersion === undefined
    : row.lifecycleVersion === LIFECYCLE_VERSION;

function restoredFields(before: MeetingHistory) {
  const set: Partial<MeetingHistory> = {};
  const removed: string[] = [];
  for (const field of STRANDED_RESTORED_FIELDS)
    if (before[field] === undefined) removed.push(field);
    else Object.assign(set, { [field]: before[field] });
  return { set, removed };
}

const ownedBy = (e: Expression, claim: FinishClaim) =>
  `${e.path("finish", "owner")} = ${e.value(claim.owner)}`;

/** A row read earlier must still be the one being claimed: same status, same finish counters. */
function seenStatusCondition(e: Expression, row: FinisherRow) {
  return row.status === undefined
    ? `attribute_not_exists(${e.path("status")})`
    : `${e.path("status")} = ${e.value(row.status)}`;
}
function seenFinishCondition(e: Expression, row: FinisherRow) {
  return row.finish
    ? `${e.path("finish", "attempts")} = ${e.value(row.finish.attempts)} AND ${e.path("finish", "phase")} = ${e.value(row.finish.phase)}`
    : `attribute_not_exists(${e.path("finish")})`;
}

const unchangedKeys = (unchanged: UnchangedFields | undefined) =>
  Object.keys(unchanged ?? {}).filter(
    (key): key is keyof UnchangedFields =>
      key === "updateDelivery" || key === "contentRevision",
  );

function unchangedCondition(
  e: Expression,
  unchanged: UnchangedFields | undefined,
) {
  return unchangedKeys(unchanged)
    .map((key) => {
      const field = e.path(key);
      const value = unchanged?.[key];
      return value === undefined
        ? ` AND attribute_not_exists(${field})`
        : ` AND ${field} = ${e.value(value)}`;
    })
    .join("");
}

function heldClaimCondition(e: Expression, claim: FinishClaim, now: number) {
  return `${e.path("meetingId")} = ${e.value(claim.meetingId)} AND ${ownedBy(e, claim)} AND ${e.path("finish", "expiresAt")} >= ${e.value(now)}`;
}

export function createDynamoMeetingFinishRepository(
  client: DynamoDBClient,
  tables: MeetingFinishTables,
): MeetingFinishRepository {
  const TableName = tables.meetingHistory;

  async function update(
    key: HistoryKey,
    e: Expression,
    input: Pick<
      UpdateItemCommandInput,
      "ConditionExpression" | "UpdateExpression" | "ReturnValues"
    >,
  ) {
    return unlessStale(() =>
      client.send(
        new UpdateItemCommand({
          TableName,
          Key: marshall(keyOf(key)),
          ...input,
          ...e.attributes(),
        }),
      ),
    );
  }

  async function updateReturning(
    key: HistoryKey,
    e: Expression,
    input: Pick<
      UpdateItemCommandInput,
      "ConditionExpression" | "UpdateExpression"
    >,
  ) {
    const result = await update(key, e, { ...input, ReturnValues: "ALL_NEW" });
    return result?.Attributes
      ? (unmarshall(result.Attributes) as MeetingHistory)
      : undefined;
  }

  async function read(key: HistoryKey) {
    const result = await client.send(
      new GetItemCommand({
        TableName,
        Key: marshall(keyOf(key)),
        ConsistentRead: true,
      }),
    );
    return result.Item
      ? (unmarshall(result.Item) as MeetingHistory)
      : undefined;
  }

  async function* scanAll(
    input: Omit<ScanCommandInput, "TableName" | "ExclusiveStartKey">,
    signal: AbortSignal,
  ) {
    let ExclusiveStartKey: ScanCommandInput["ExclusiveStartKey"];
    do {
      if (signal.aborted) return;
      let page;
      try {
        page = await client.send(
          new ScanCommand({ ...input, TableName, ExclusiveStartKey }),
          { abortSignal: signal },
        );
      } catch (error) {
        if (signal.aborted) return;
        throw error;
      }
      for (const item of page.Items ?? []) yield unmarshall(item);
      ExclusiveStartKey = page.LastEvaluatedKey;
    } while (ExclusiveStartKey);
  }

  return {
    async *scan(signal) {
      const e = new Expression();
      const filter = `${e.path("lifecycleVersion")} = ${e.value(LIFECYCLE_VERSION)} AND (${e.path("status")} IN (${e.list(OPEN_STATUSES)}) OR attribute_exists(${e.path("finish")}))`;
      const projection = FINISHER_ROW_FIELDS.map((field) => e.path(field)).join(
        ", ",
      );
      // ponytail: full table scan each minute, add a sparse GSI on open meetings when the table grows
      for await (const item of scanAll(
        {
          ConsistentRead: true,
          FilterExpression: filter,
          ProjectionExpression: projection,
          ...e.attributes(),
        },
        signal,
      ))
        yield item as FinisherRow;
    },

    async recordCaptureEnd({ reservation, patch, claimOwner, now }) {
      if (reservation.sessionMode !== "meeting")
        throw new Error("Capture end requires a meeting reservation");
      const e = new Expression();
      const condition = `${e.path("meetingId")} = ${e.value(reservation.meetingId)} AND ${e.path("ownerInstanceId")} = ${e.value(reservation.ownerInstanceId)} AND ${e.path("status")} IN (${e.list(LIVE_STATUSES)})`;
      const result = await update(reservation.historyKey, e, {
        ConditionExpression: condition,
        UpdateExpression: `SET ${e.assignments(captureEndFields(patch, claimOwner, now))}`,
      });
      if (result !== undefined) return true;
      if (!claimOwner) return false;
      const current = await client.send(
        new GetItemCommand({
          TableName,
          Key: marshall(keyOf(reservation.historyKey)),
          ConsistentRead: true,
        }),
      );
      return Boolean(
        current.Item &&
        alreadyRecorded(
          unmarshall(current.Item) as MeetingHistory,
          reservation,
          claimOwner,
        ),
      );
    },

    async claim(row, owner, now, options) {
      const e = new Expression();
      const nowValue = e.value(now);
      const version = versionCondition(e, options);
      const nextAttemptAt = e.path("finish", "nextAttemptAt");
      const condition = `${e.path("meetingId")} = ${e.value(row.meetingId)} AND ${version} AND (attribute_not_exists(${e.path("finish", "owner")}) OR ${e.path("finish", "expiresAt")} < ${nowValue}) AND (attribute_not_exists(${nextAttemptAt}) OR ${nextAttemptAt} <= ${nowValue}) AND ${seenStatusCondition(e, row)} AND ${seenFinishCondition(e, row)}`;
      const history = await updateReturning(row, e, {
        ConditionExpression: condition,
        UpdateExpression: `SET ${e.path("finish")} = ${e.value(claimedFinish(row.finish, owner, now))}`,
      });
      return history && claimFor(row, owner, history);
    },

    async adopt(row, owner, derived, now, options) {
      const lease = new Expression();
      const historyUpdate = new Expression();
      const leaseCondition = `attribute_not_exists(${lease.path("guildId")}) OR ${lease.path("meetingId")} <> ${lease.value(row.meetingId)} OR ${lease.path("leaseExpiresAt")} < ${lease.value(now)}`;
      const h = historyUpdate;
      const historyCondition = `${h.path("meetingId")} = ${h.value(row.meetingId)} AND ${versionCondition(h, options)} AND ${h.path("status")} IN (${h.list(LIVE_STATUSES)}) AND ${row.finish ? `attribute_not_exists(${h.path("finish", "owner")}) AND ` : ""}${seenFinishCondition(h, row)}`;
      const written = await unlessStale(() =>
        client.send(
          new TransactWriteItemsCommand({
            TransactItems: [
              {
                ConditionCheck: {
                  TableName: tables.activeMeeting,
                  Key: marshall({ guildId: row.guildId }),
                  ConditionExpression: leaseCondition,
                  ...lease.attributes(),
                },
              },
              {
                Update: {
                  TableName,
                  Key: marshall(keyOf(row)),
                  ConditionExpression: historyCondition,
                  UpdateExpression: `SET ${historyUpdate.assignments(adoptedFields(row, owner, derived, now))}`,
                  ...historyUpdate.attributes(),
                },
              },
            ],
          }),
        ),
      );
      if (!written) return undefined;
      const history = await read(row);
      return history && claimFor(row, owner, history);
    },

    read,

    async renew(claim, now) {
      const e = new Expression();
      const result = await update(claim.key, e, {
        ConditionExpression: heldClaimCondition(e, claim, now),
        UpdateExpression: `SET ${e.path("finish", "expiresAt")} = ${e.value(now + LIFECYCLE.finishClaimSeconds)}`,
      });
      return result !== undefined;
    },

    async save(claim, patch, now, expectedStatus, unchanged, remove = []) {
      const e = new Expression();
      const status =
        expectedStatus === undefined
          ? ""
          : ` AND ${e.path("status")} = ${e.value(expectedStatus)}`;
      const removed = remove.length
        ? ` REMOVE ${remove.map((field) => e.path(field)).join(", ")}`
        : "";
      return updateReturning(claim.key, e, {
        ConditionExpression:
          heldClaimCondition(e, claim, now) +
          status +
          unchangedCondition(e, unchanged),
        UpdateExpression: `SET ${e.assignments(savedFields(patch, now))}${removed}`,
      });
    },

    async releaseDone(claim) {
      const e = new Expression();
      await update(claim.key, e, {
        ConditionExpression: ownedBy(e, claim),
        UpdateExpression: `REMOVE ${e.path("finish")}`,
      });
    },

    async releaseForRetry(claim, next) {
      const e = new Expression();
      await update(claim.key, e, {
        ConditionExpression: ownedBy(e, claim),
        UpdateExpression: `SET ${e.path("finish")} = ${e.value(retryFinish(next))}`,
      });
    },

    async releaseUnclaimed(claim) {
      const e = new Expression();
      await update(claim.key, e, {
        ConditionExpression: ownedBy(e, claim),
        UpdateExpression: `REMOVE ${e.path("finish", "owner")}, ${e.path("finish", "expiresAt")}`,
      });
    },

    async abandon(row, now) {
      const e = new Expression();
      const processing = e.path("processing");
      const result = await update(row, e, {
        ConditionExpression: `${e.path("meetingId")} = ${e.value(row.meetingId)} AND ${e.path("lifecycleVersion")} = ${e.value(LIFECYCLE_VERSION)} AND ${e.path("status")} IN (${e.list(OPEN_STATUSES)})`,
        UpdateExpression: `SET ${e.assignments({ status: MEETING_STATUS.FAILED, updatedAt: isoAt(now) })}, ${processing} = if_not_exists(${processing}, ${e.value(TRANSCRIPTION_FAILED)}) REMOVE ${e.path("finish")}`,
      });
      return result !== undefined;
    },

    async *listStranded(signal) {
      const e = new Expression();
      for await (const item of scanAll(
        {
          FilterExpression: `attribute_not_exists(${e.path("lifecycleVersion")}) AND ${e.path("status")} IN (${e.list(OPEN_STATUSES)})`,
          ...e.attributes(),
        },
        signal,
      ))
        yield item as MeetingHistory;
    },

    async restoreStranded(claim, before) {
      const e = new Expression();
      const owner = e.path("finish", "owner");
      const condition = `${e.path("meetingId")} = ${e.value(claim.meetingId)} AND ${versionCondition(e, { operator: true })} AND ${e.path("status")} IN (${e.list(OPEN_STATUSES)}) AND (attribute_not_exists(${owner}) OR ${owner} = ${e.value(claim.owner)})`;
      const restored = restoredFields(before);
      const removed = restored.removed.map((field) => e.path(field));
      const result = await update(claim.key, e, {
        ConditionExpression: condition,
        UpdateExpression: `SET ${e.assignments(restored.set)}${removed.length ? ` REMOVE ${removed.join(", ")}` : ""}`,
      });
      return result !== undefined;
    },
  };
}

function mockSeenFinish(stored: MeetingHistory, seen: FinisherRow) {
  return seen.finish
    ? stored.finish?.attempts === seen.finish.attempts &&
        stored.finish.phase === seen.finish.phase
    : stored.finish === undefined;
}

function mockClaimable(
  row: MeetingHistory,
  seen: FinisherRow,
  operator: boolean,
  now: number,
) {
  const finish = row.finish;
  return (
    row.meetingId === seen.meetingId &&
    row.status === seen.status &&
    mockSeenFinish(row, seen) &&
    markedAs(row, { operator }) &&
    (finish?.owner === undefined ||
      (finish.expiresAt !== undefined && finish.expiresAt < now)) &&
    (finish?.nextAttemptAt === undefined || finish.nextAttemptAt <= now)
  );
}

function mockHolds(
  row: MeetingHistory | undefined,
  claim: FinishClaim,
  now: number,
) {
  const finish = row?.finish;
  return (
    row?.meetingId === claim.meetingId &&
    finish?.owner === claim.owner &&
    finish.expiresAt !== undefined &&
    finish.expiresAt >= now
  );
}

function mockLeaseNames(
  lease: ActiveMeetingLease | undefined,
  meetingId: string,
  now: number,
) {
  return (
    lease !== undefined &&
    lease.meetingId === meetingId &&
    lease.leaseExpiresAt >= now
  );
}

function projectFinisherRow(row: MeetingHistory): FinisherRow {
  const {
    guildId,
    channelId_timestamp,
    meetingId,
    status,
    timestamp,
    updatedAt,
    lifecycleVersion,
    finish,
    ownerInstanceId,
  } = row;
  return structuredClone({
    guildId,
    channelId_timestamp,
    meetingId,
    status,
    timestamp,
    updatedAt,
    lifecycleVersion,
    finish,
    ownerInstanceId,
  });
}

export function createMockMeetingFinishRepository(
  histories: Map<string, MeetingHistory[]>,
  leases: Map<string, ActiveMeetingLease>,
): MeetingFinishRepository {
  const find = (key: HistoryKey) =>
    histories
      .get(key.guildId)
      ?.find((row) => row.channelId_timestamp === key.channelId_timestamp);
  const allRows = () => [...histories.values()].flat();
  const apply = (row: MeetingHistory, fields: Partial<MeetingHistory>) => {
    Object.assign(row, defined(fields));
    return structuredClone(row);
  };
  const releaseHeld = (
    claim: FinishClaim,
    release: (row: MeetingHistory) => void,
  ) => {
    const row = find(claim.key);
    if (row?.finish?.owner === claim.owner) release(row);
  };

  return {
    async *scan(signal) {
      for (const row of allRows()) {
        if (signal.aborted) return;
        if (
          row.lifecycleVersion === LIFECYCLE_VERSION &&
          (isOpen(row.status) || row.finish !== undefined)
        )
          yield projectFinisherRow(row);
      }
    },

    async recordCaptureEnd({ reservation, patch, claimOwner, now }) {
      if (reservation.sessionMode !== "meeting")
        throw new Error("Capture end requires a meeting reservation");
      const row = find(reservation.historyKey);
      if (row && claimOwner && alreadyRecorded(row, reservation, claimOwner))
        return true;
      if (
        row?.meetingId !== reservation.meetingId ||
        row.ownerInstanceId !== reservation.ownerInstanceId ||
        !isLive(row.status)
      )
        return false;
      apply(row, captureEndFields(patch, claimOwner, now));
      return true;
    },

    async claim(row, owner, now, options) {
      const stored = find(row);
      if (
        !stored ||
        !mockClaimable(stored, row, Boolean(options?.operator), now)
      )
        return undefined;
      return claimFor(
        row,
        owner,
        apply(stored, { finish: claimedFinish(row.finish, owner, now) }),
      );
    },

    async adopt(row, owner, derived, now, options) {
      const stored = find(row);
      if (
        mockLeaseNames(leases.get(row.guildId), row.meetingId, now) ||
        stored?.meetingId !== row.meetingId ||
        !markedAs(stored, options) ||
        !isLive(stored.status) ||
        stored.finish?.owner !== undefined ||
        !mockSeenFinish(stored, row)
      )
        return undefined;
      return claimFor(
        row,
        owner,
        apply(stored, adoptedFields(row, owner, derived, now)),
      );
    },

    async read(key) {
      const row = find(key);
      return row && structuredClone(row);
    },

    async renew(claim, now) {
      const row = find(claim.key);
      const finish = row?.finish;
      if (!finish || !mockHolds(row, claim, now)) return false;
      finish.expiresAt = now + LIFECYCLE.finishClaimSeconds;
      return true;
    },

    async save(claim, patch, now, expectedStatus, unchanged, remove = []) {
      const row = find(claim.key);
      if (
        !row ||
        !mockHolds(row, claim, now) ||
        (expectedStatus !== undefined && row.status !== expectedStatus) ||
        unchangedKeys(unchanged).some(
          (key) =>
            // Cloning both sides compares values the way DynamoDB does, not object prototypes.
            !isDeepStrictEqual(
              structuredClone(row[key]),
              structuredClone(unchanged?.[key]),
            ),
        )
      )
        return undefined;
      for (const field of remove) delete row[field];
      return apply(row, structuredClone(savedFields(patch, now)));
    },

    async releaseDone(claim) {
      releaseHeld(claim, (row) => {
        delete row.finish;
      });
    },

    async releaseForRetry(claim, next) {
      releaseHeld(claim, (row) => {
        row.finish = retryFinish(next);
      });
    },

    async releaseUnclaimed(claim) {
      releaseHeld(claim, (row) => {
        delete row.finish?.owner;
        delete row.finish?.expiresAt;
      });
    },

    async abandon(row, now) {
      const stored = find(row);
      if (
        stored?.meetingId !== row.meetingId ||
        stored.lifecycleVersion !== LIFECYCLE_VERSION ||
        !isOpen(stored.status)
      )
        return false;
      apply(stored, {
        status: MEETING_STATUS.FAILED,
        updatedAt: isoAt(now),
        processing: stored.processing ?? TRANSCRIPTION_FAILED,
      });
      delete stored.finish;
      return true;
    },

    async *listStranded(signal) {
      for (const row of allRows()) {
        if (signal.aborted) return;
        if (row.lifecycleVersion === undefined && isOpen(row.status))
          yield structuredClone(row);
      }
    },

    async restoreStranded(claim, before) {
      const row = find(claim.key);
      const owner = row?.finish?.owner;
      if (
        row?.meetingId !== claim.meetingId ||
        !markedAs(row, { operator: true }) ||
        !isOpen(row.status) ||
        (owner !== undefined && owner !== claim.owner)
      )
        return false;
      const restored = restoredFields(before);
      Object.assign(row, structuredClone(restored.set));
      for (const field of restored.removed) Reflect.deleteProperty(row, field);
      return true;
    },
  };
}

export function getMeetingFinishRepository(): MeetingFinishRepository {
  if (!config.mock.enabled)
    return createDynamoMeetingFinishRepository(dynamoDbClient, {
      meetingHistory: tableName("MeetingHistoryTable"),
      activeMeeting: tableName("ActiveMeetingTable"),
    });
  const store = getMockStore();
  return createMockMeetingFinishRepository(
    store.meetingHistoryByGuild,
    store.activeMeetingLeases,
  );
}
