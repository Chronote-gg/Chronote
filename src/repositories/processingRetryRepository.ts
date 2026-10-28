import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  QueryCommand,
  ScanCommand,
  TransactWriteItemsCommand,
  UpdateItemCommand,
  type DynamoDBClient,
} from "@aws-sdk/client-dynamodb";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";
import { z } from "zod";
import { controlTableNames, dynamoDbClient } from "../db";
import { config } from "../services/configService";
import { buildWorkAdmissionChecks } from "../services/deploymentControlTransactions";
import type { MeetingHistory } from "../types/db";
import type {
  ControlTableNames,
  WorkAdmissionAuthority,
} from "../types/deploymentControl";
import {
  PROCESSING_RETRY_DUE_INDEX,
  PROCESSING_RETRY_QUEUE,
  processingRetryJobSchema,
  type ProcessingRetryJob,
} from "../types/meetingProcessingRetry";
import {
  readMeetingUpdateRevisions,
  type MeetingUpdateKey,
} from "../types/meetingUpdateDelivery";
import { classifyDeploymentTransactionError } from "./deploymentControlErrors";
import { mockWorkAdmissionAllowed } from "./deploymentControlRepository";
import { readDynamoIndexStatus } from "./dynamoIndexStatus";
import {
  createDynamoMeetingUpdateDeliveryRepository,
  mayHaveCommitted,
  validateDue,
} from "./meetingUpdateDeliveryRepository";
import {
  meetingUpdateKeySchema,
  parseMeetingUpdateHistory,
} from "./meetingUpdateDeliveryState";
import { createMockMeetingUpdateDeliveryRepository } from "./mockMeetingUpdateDeliveryRepository";
import { getMockStore } from "./mockStore";

type ClaimHolder = {
  key: MeetingUpdateKey;
  jobId: string;
  ownerInstanceId: string;
  claimId: string;
};
export type ProcessingRetryQueueInput = {
  key: MeetingUpdateKey;
  expected: Pick<
    MeetingHistory,
    "processing" | "notesVersion" | "processingRetry"
  >;
  job: ProcessingRetryJob;
  dueAt: number;
};
export type ProcessingRetryClaimInput = {
  key: MeetingUpdateKey;
  jobId: string;
  ownerInstanceId: string;
  now: number;
  leaseExpiresAt: number;
  authority: WorkAdmissionAuthority;
  signal?: AbortSignal;
};
export type ProcessingRetryFailInput = {
  key: MeetingUpdateKey;
  expected: ProcessingRetryJob;
  failed: ProcessingRetryJob;
};
export type ProcessingRetryDueInput = {
  now: number;
  limit: number;
  signal?: AbortSignal;
};
export type ProcessingRetryScanInput = {
  from: string;
  to: string;
  guildId?: string;
  cursor?: string;
};
export type ProcessingRetryScanPage = {
  rows: MeetingHistory[];
  cursor?: string;
};
export type ProcessingRetryRepository = {
  queue(input: ProcessingRetryQueueInput): Promise<"queued" | "conflict">;
  listDue(input: ProcessingRetryDueInput): Promise<MeetingUpdateKey[]>;
  claim(
    input: ProcessingRetryClaimInput,
  ): Promise<ProcessingRetryJob | undefined>;
  renew(input: ClaimHolder & { leaseExpiresAt: number }): Promise<boolean>;
  fail(input: ProcessingRetryFailInput): Promise<"applied" | "stale">;
  scan(input: ProcessingRetryScanInput): Promise<ProcessingRetryScanPage>;
};

const RETRY_FIELDS = [
  "processingRetry",
  "processingRetryQueue",
  "processingRetryDueAt",
] as const;
type RetryFields = Pick<MeetingHistory, (typeof RETRY_FIELDS)[number]>;
const QUEUE_PINS = ["processing", "notesVersion", "processingRetry"] as const;
type PinnedField = (typeof QUEUE_PINS)[number];
/** The next retry fields, written only while the pinned fields still hold what was read. */
type RetryWrite = { next: RetryFields; pinned: readonly PinnedField[] };
type RetryStore = {
  read(
    key: MeetingUpdateKey,
    signal?: AbortSignal,
  ): Promise<MeetingHistory | undefined>;
  write(
    before: MeetingHistory,
    change: RetryWrite,
    authority?: WorkAdmissionAuthority,
    signal?: AbortSignal,
  ): Promise<boolean>;
  listDue(input: ProcessingRetryDueInput): Promise<MeetingUpdateKey[]>;
  scan(input: ProcessingRetryScanInput): Promise<ProcessingRetryScanPage>;
};

const seconds = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const notesVersionOf = (row: Pick<MeetingHistory, "notesVersion">) =>
  readMeetingUpdateRevisions({ notesVersion: row.notesVersion }).notesVersion;
/** Equality as DynamoDB sees it: undefined members are absent, and the object realm does not matter. */
function stored(value: unknown): unknown {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}
const same = (left: unknown, right: unknown) =>
  isDeepStrictEqual(stored(left), stored(right));
const isTerminal = (job: ProcessingRetryJob) =>
  job.status === "succeeded" || job.status === "failed";
const queued = (job: ProcessingRetryJob, dueAt: number): RetryFields => ({
  processingRetry: job,
  processingRetryQueue: PROCESSING_RETRY_QUEUE,
  processingRetryDueAt: dueAt,
});

function queueWrite(
  row: MeetingHistory,
  input: ProcessingRetryQueueInput,
): RetryWrite | undefined {
  const previous = row.processingRetry;
  if (
    !same(row.processing, input.expected.processing) ||
    notesVersionOf(row) !== notesVersionOf(input.expected) ||
    !same(previous, input.expected.processingRetry) ||
    (previous && !isTerminal(previous))
  )
    return undefined;
  return { next: queued(input.job, input.dueAt), pinned: QUEUE_PINS };
}

/** A lapsed lease is claimable again; its index entry came due when the lease did. */
function claimWrite(
  row: MeetingHistory,
  input: ProcessingRetryClaimInput,
  claimId: string,
): RetryWrite | undefined {
  const job = row.processingRetry;
  if (job?.jobId !== input.jobId) return undefined;
  const lapsed =
    job.status === "running" &&
    job.claim !== undefined &&
    job.claim.leaseExpiresAt <= input.now;
  if (job.status !== "queued" && !lapsed) return undefined;
  const claimed = processingRetryJobSchema.parse({
    ...job,
    status: "running",
    claim: {
      ownerInstanceId: input.ownerInstanceId,
      claimId,
      leaseExpiresAt: input.leaseExpiresAt,
    },
    updatedAt: new Date(input.now * 1000).toISOString(),
  });
  return {
    next: queued(claimed, input.leaseExpiresAt),
    pinned: ["processingRetry"],
  };
}

function heldClaim(row: MeetingHistory, holder: Omit<ClaimHolder, "key">) {
  const job = row.processingRetry;
  return job?.jobId === holder.jobId &&
    job.status === "running" &&
    job.claim?.ownerInstanceId === holder.ownerInstanceId &&
    job.claim.claimId === holder.claimId
    ? { job, claim: job.claim }
    : undefined;
}

function renewWrite(
  row: MeetingHistory,
  input: ClaimHolder & { leaseExpiresAt: number },
): RetryWrite | undefined {
  const held = heldClaim(row, input);
  if (!held) return undefined;
  const renewed = {
    ...held.job,
    claim: { ...held.claim, leaseExpiresAt: input.leaseExpiresAt },
  };
  return {
    next: queued(renewed, input.leaseExpiresAt),
    pinned: ["processingRetry"],
  };
}

/** Only the claim that is still running may fail its job, so a saved success is never overwritten. */
function failWrite(
  row: MeetingHistory,
  input: ProcessingRetryFailInput,
): RetryWrite | undefined {
  const claim = input.expected.claim;
  if (!claim || !heldClaim(row, { jobId: input.expected.jobId, ...claim }))
    return undefined;
  return {
    next: {
      processingRetry: input.failed,
      processingRetryQueue: undefined,
      processingRetryDueAt: undefined,
    },
    pinned: ["processingRetry"],
  };
}

function validateQueue(input: ProcessingRetryQueueInput) {
  const job = processingRetryJobSchema.parse(input.job);
  if (job.status !== "queued" || job.claim)
    throw new Error("A queued retry job starts unclaimed");
  seconds.parse(input.dueAt);
}
function validateClaim(input: ProcessingRetryClaimInput) {
  seconds.parse(input.now);
  if (seconds.parse(input.leaseExpiresAt) <= input.now)
    throw new Error("A retry lease must expire after it starts");
}
function validateFail(input: ProcessingRetryFailInput) {
  const failed = processingRetryJobSchema.parse(input.failed);
  if (
    failed.status !== "failed" ||
    failed.jobId !== input.expected.jobId ||
    failed.claim
  )
    throw new Error("A failed retry job keeps its id and drops its claim");
}

function repositoryOver(store: RetryStore): ProcessingRetryRepository {
  async function apply(
    key: MeetingUpdateKey,
    plan: (row: MeetingHistory) => RetryWrite | undefined,
    authority?: WorkAdmissionAuthority,
    signal?: AbortSignal,
  ): Promise<RetryFields | undefined> {
    const row = await store.read(key, signal);
    const change = row && plan(row);
    if (!row || !change) return undefined;
    return (await store.write(row, change, authority, signal))
      ? change.next
      : undefined;
  }
  return {
    async queue(input) {
      validateQueue(input);
      const saved = await apply(input.key, (row) => queueWrite(row, input));
      return saved ? "queued" : "conflict";
    },
    async claim(input) {
      validateClaim(input);
      const claimId = randomUUID();
      const saved = await apply(
        input.key,
        (row) => claimWrite(row, input, claimId),
        input.authority,
        input.signal,
      );
      return saved?.processingRetry;
    },
    async renew(input) {
      seconds.parse(input.leaseExpiresAt);
      return Boolean(await apply(input.key, (row) => renewWrite(row, input)));
    },
    async fail(input) {
      validateFail(input);
      const saved = await apply(input.key, (row) => failWrite(row, input));
      return saved ? "applied" : "stale";
    },
    async listDue(input) {
      validateDue(input);
      return store.listDue(input);
    },
    scan: (input) => store.scan(input),
  };
}

function withRetryFields(
  row: MeetingHistory,
  next: RetryFields,
): MeetingHistory {
  const saved = { ...row, ...next };
  for (const field of RETRY_FIELDS)
    if (next[field] === undefined) delete saved[field];
  return saved;
}
function inWindow(row: MeetingHistory, input: ProcessingRetryScanInput) {
  return (
    row.processing !== undefined &&
    row.timestamp >= input.from &&
    row.timestamp <= input.to &&
    (!input.guildId || row.guildId === input.guildId)
  );
}
const keyOf = (row: MeetingHistory): MeetingUpdateKey => ({
  guildId: row.guildId,
  channelId_timestamp: row.channelId_timestamp,
});

export function createMockProcessingRetryRepository(
  histories: Map<string, MeetingHistory[]>,
  admit: (authority: WorkAdmissionAuthority) => boolean,
): ProcessingRetryRepository {
  const rows = createMockMeetingUpdateDeliveryRepository(histories, admit);
  const all = () => [...histories.values()].flat();
  return repositoryOver({
    read: (key, signal) => rows.getStrong(key, signal),
    async write(before, change, authority) {
      if (authority && !admit(authority)) return false;
      const list = histories.get(before.guildId) ?? [];
      const index = list.findIndex(
        (row) => row.channelId_timestamp === before.channelId_timestamp,
      );
      const current = list[index];
      if (
        !current ||
        change.pinned.some((field) => !same(current[field], before[field]))
      )
        return false;
      list[index] = structuredClone(withRetryFields(current, change.next));
      return true;
    },
    async listDue(input) {
      input.signal?.throwIfAborted();
      return all()
        .filter(
          (row): row is MeetingHistory & { processingRetryDueAt: number } =>
            row.processingRetryQueue === PROCESSING_RETRY_QUEUE &&
            row.processingRetryDueAt !== undefined &&
            row.processingRetryDueAt <= input.now,
        )
        .sort(
          (left, right) =>
            left.processingRetryDueAt - right.processingRetryDueAt,
        )
        .slice(0, input.limit)
        .map(keyOf);
    },
    // ponytail: the mock returns one page; Dynamo pages through LastEvaluatedKey.
    async scan(input) {
      return {
        rows: all()
          .filter((row) => inWindow(row, input))
          .map((row) => structuredClone(row)),
      };
    },
  });
}

function retryUpdate(
  table: string,
  before: MeetingHistory,
  change: RetryWrite,
) {
  const names: Record<string, string> = { "#meeting": "meetingId" };
  const values: Record<string, unknown> = { ":meeting": before.meetingId };
  const conditions = ["attribute_exists(guildId)", "#meeting = :meeting"];
  change.pinned.forEach((field, index) => {
    names[`#p${index}`] = field;
    if (before[field] === undefined)
      conditions.push(`attribute_not_exists(#p${index})`);
    else {
      conditions.push(`#p${index} = :p${index}`);
      values[`:p${index}`] = before[field];
    }
  });
  const set: string[] = [];
  const remove: string[] = [];
  RETRY_FIELDS.forEach((field, index) => {
    names[`#r${index}`] = field;
    if (change.next[field] === undefined) remove.push(`#r${index}`);
    else {
      set.push(`#r${index} = :r${index}`);
      values[`:r${index}`] = change.next[field];
    }
  });
  return {
    TableName: table,
    Key: marshall(keyOf(before)),
    ConditionExpression: conditions.join(" AND "),
    UpdateExpression: [
      set.length ? `SET ${set.join(", ")}` : "",
      remove.length ? `REMOVE ${remove.join(", ")}` : "",
    ]
      .filter(Boolean)
      .join(" "),
    ExpressionAttributeNames: names,
    ExpressionAttributeValues: marshall(values, {
      removeUndefinedValues: true,
    }),
  };
}
const readScanCursor = (cursor: string) =>
  meetingUpdateKeySchema.parse(JSON.parse(cursor));

export function createDynamoProcessingRetryRepository(
  client: DynamoDBClient,
  tables: ControlTableNames,
): ProcessingRetryRepository {
  const rows = createDynamoMeetingUpdateDeliveryRepository(client, tables);
  async function send(
    update: ReturnType<typeof retryUpdate>,
    authority?: WorkAdmissionAuthority,
    signal?: AbortSignal,
  ) {
    if (!authority)
      return client.send(new UpdateItemCommand(update), {
        abortSignal: signal,
      });
    return client.send(
      new TransactWriteItemsCommand({
        TransactItems: [
          ...buildWorkAdmissionChecks(authority, tables),
          { Update: update },
        ],
      }),
      { abortSignal: signal },
    );
  }
  return repositoryOver({
    read: (key, signal) => rows.getStrong(key, signal),
    async write(before, change, authority, signal) {
      try {
        await send(
          retryUpdate(tables.meetingHistory, before, change),
          authority,
          signal,
        );
        return true;
      } catch (error) {
        if (classifyDeploymentTransactionError(error) === "stale") return false;
        if (!mayHaveCommitted(error)) throw error;
        const actual = await rows.getStrong(keyOf(before));
        if (
          actual &&
          RETRY_FIELDS.every((field) => same(actual[field], change.next[field]))
        )
          return true;
        throw error;
      }
    },
    async listDue(input) {
      const result = await client.send(
        new QueryCommand({
          TableName: tables.meetingHistory,
          IndexName: PROCESSING_RETRY_DUE_INDEX,
          KeyConditionExpression:
            "processingRetryQueue = :queue AND processingRetryDueAt <= :now",
          ExpressionAttributeValues: marshall({
            ":queue": PROCESSING_RETRY_QUEUE,
            ":now": input.now,
          }),
          Limit: input.limit,
        }),
        { abortSignal: input.signal },
      );
      return (result.Items ?? []).map((item) => {
        const { guildId, channelId_timestamp } = unmarshall(item);
        return meetingUpdateKeySchema.parse({ guildId, channelId_timestamp });
      });
    },
    async scan(input) {
      const result = await client.send(
        new ScanCommand({
          TableName: tables.meetingHistory,
          FilterExpression: [
            "#timestamp BETWEEN :from AND :to",
            "attribute_exists(#processing)",
            ...(input.guildId ? ["guildId = :guild"] : []),
          ].join(" AND "),
          ExpressionAttributeNames: {
            "#timestamp": "timestamp",
            "#processing": "processing",
          },
          ExpressionAttributeValues: marshall({
            ":from": input.from,
            ":to": input.to,
            ...(input.guildId ? { ":guild": input.guildId } : {}),
          }),
          ExclusiveStartKey: input.cursor
            ? marshall(readScanCursor(input.cursor))
            : undefined,
        }),
      );
      return {
        rows: (result.Items ?? []).map((item) =>
          parseMeetingUpdateHistory(unmarshall(item)),
        ),
        ...(result.LastEvaluatedKey
          ? {
              cursor: JSON.stringify(
                meetingUpdateKeySchema.parse(
                  unmarshall(result.LastEvaluatedKey),
                ),
              ),
            }
          : {}),
      };
    },
  });
}

export function getProcessingRetryRepository(): ProcessingRetryRepository {
  if (!config.mock.enabled)
    return createDynamoProcessingRetryRepository(
      dynamoDbClient,
      controlTableNames(),
    );
  const store = getMockStore();
  return createMockProcessingRetryRepository(
    store.meetingHistoryByGuild,
    (authority) =>
      mockWorkAdmissionAllowed(
        authority,
        store.deploymentControlRecords,
        store.activeMeetingLeases,
      ),
  );
}
export const getProcessingRetryIndexStatus = () =>
  readDynamoIndexStatus(dynamoDbClient, {
    mock: config.mock.enabled,
    tableName: controlTableNames().meetingHistory,
    indexName: PROCESSING_RETRY_DUE_INDEX,
  });
