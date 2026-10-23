import {
  publicationMutationExcluded,
  publicationSnapshot,
  publicationSnapshotCondition,
  type MeetingPublicationSnapshot,
} from "../types/meetingPublication";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  DynamoDBClient,
  GetItemCommand,
  QueryCommand,
  TransactWriteItemsCommand,
  UpdateItemCommand,
  type UpdateItemCommandInput,
} from "@aws-sdk/client-dynamodb";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";
import { z } from "zod";
import type {
  MeetingHistory,
  NotesEditSource,
  SuggestionHistoryEntry,
} from "../types/db";
import type {
  ControlTableNames,
  WorkAdmissionAuthority,
} from "../types/deploymentControl";
import {
  MEETING_UPDATE_DELIVERY_DUE_INDEX,
  MEETING_UPDATE_DELIVERY_QUEUE,
  meetingUpdateDeliverySchema,
  preparedMeetingUpdateAttemptSchema,
  notesPointersSchema,
  readMeetingUpdateDeliveryCursor,
  writeMeetingUpdateDeliveryCursor,
  meetingUpdateDeliveryCursorSchema,
  presentationPartSchema,
  meetingUpdateDeliveryNextCheck,
  assertMeetingUpdateDeliveryTransition,
  type MeetingUpdateKey,
  type MeetingUpdateDelivery,
  type MeetingUpdateMutation,
  type PreparedMeetingUpdateAttempt,
  type MeetingUpdateDeliveryTransition,
  type NotesPointers,
} from "../types/meetingUpdateDelivery";
import { buildWorkAdmissionChecks } from "../services/deploymentControlTransactions";
import { classifyDeploymentTransactionError } from "./deploymentControlRepository";
import {
  applyDeliveryChange,
  assertMeetingItemSize,
  contentMatches,
  meetingUpdateKeySchema,
  isExactContentMutation,
  canCompareContentWrite,
  parseMeetingUpdateHistory,
  pointersFor,
  prepareContentWrite,
  withDelivery,
} from "./meetingUpdateDeliveryState";

export type MeetingContentWrite = {
  expectedPublication?: MeetingPublicationSnapshot;
  key: MeetingUpdateKey;
  expectedContentRevision: number;
  expectedDeliveryRevision: string | null;
  mutation: MeetingUpdateMutation;
  nextDelivery: MeetingUpdateDelivery;
  mutationId: string;
  at: number;
  notesEdit?: {
    expectedNotesVersion: number;
    editedBy: string;
    source?: NotesEditSource;
    suggestion?: SuggestionHistoryEntry;
  };
};
export type MeetingWriteResult =
  { kind: "committed"; history: MeetingHistory } | { kind: "conflict" };
export type MeetingClaim = {
  key: MeetingUpdateKey;
  expectedContentRevision: number;
  expectedDeliveryRevision: string;
  attempt: PreparedMeetingUpdateAttempt;
  authority: WorkAdmissionAuthority;
  signal?: AbortSignal;
};
export type MeetingDeliveryTransition = {
  key: MeetingUpdateKey;
  expectedDeliveryRevision: string;
  attemptId: string | null;
  ownerInstanceId: string | null;
  change: MeetingUpdateDeliveryTransition;
  signal?: AbortSignal;
};
export type MeetingPointerRegistration = {
  key: MeetingUpdateKey;
  expectedContentRevision: number;
  expectedDeliveryRevision: string;
  attemptId: string;
  expectedPointers: NotesPointers;
  nextPointers: NotesPointers;
  signal?: AbortSignal;
};
export type MeetingDueInput = {
  now: number;
  limit: number;
  cursor?: string;
  signal?: AbortSignal;
};
export type MeetingDuePage = { keys: MeetingUpdateKey[]; cursor?: string };
export type MeetingUpdateDeliveryRepository = {
  getStrong(
    key: MeetingUpdateKey,
    signal?: AbortSignal,
  ): Promise<MeetingHistory | undefined>;
  updateContentAndDelivery(
    input: MeetingContentWrite,
    signal?: AbortSignal,
  ): Promise<MeetingWriteResult>;
  listDue(input: MeetingDueInput): Promise<MeetingDuePage>;
  claim(input: MeetingClaim): Promise<"claimed" | "stale">;
  transition(input: MeetingDeliveryTransition): Promise<"applied" | "stale">;
  registerNotesPointers(
    input: MeetingPointerRegistration,
  ): Promise<"applied" | "stale">;
};
export const MEETING_UPDATE_CLAIM_LEASE_SECONDS = 60;
export function validateDue(input: MeetingDueInput) {
  z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).parse(input.now);
  z.number().int().min(1).max(25).parse(input.limit);
  return readMeetingUpdateDeliveryCursor(input.cursor);
}
function claimAuthorityMatches(
  row: MeetingHistory,
  authority: WorkAdmissionAuthority,
): boolean {
  return (
    authority.kind === "serving" ||
    (authority.ownership.guildId === row.guildId &&
      authority.ownership.meetingId === row.meetingId)
  );
}
export function claimDelivery(
  row: MeetingHistory,
  input: MeetingClaim,
): MeetingUpdateDelivery | undefined {
  if (
    !claimAuthorityMatches(row, input.authority) ||
    publicationMutationExcluded(publicationSnapshot(row))
  )
    return undefined;
  if (!contentMatches(row, input) || !row.updateDelivery) return undefined;
  const before = meetingUpdateDeliverySchema.parse(row.updateDelivery);
  const attempt = preparedMeetingUpdateAttemptSchema.parse(input.attempt);
  const now =
    input.authority.kind === "serving"
      ? input.authority.context.now
      : input.authority.now;
  const ownerInstanceId =
    input.authority.kind === "serving"
      ? input.authority.context.instanceId
      : input.authority.ownership.ownerInstanceId;
  const due = meetingUpdateDeliveryNextCheck(before);
  if (due === undefined || due > now) return undefined;
  let progress: MeetingUpdateDelivery["progress"];
  if ("attempt" in before.progress) {
    if (
      before.progress.claim.leaseExpiresAt >= now ||
      !isDeepStrictEqual(before.progress.attempt, attempt)
    )
      return undefined;
    progress = {
      ...before.progress,
      kind: "reconciling",
      claim: {
        ownerInstanceId,
        leaseExpiresAt: now + MEETING_UPDATE_CLAIM_LEASE_SECONDS,
      },
      nextCheckAt: now + MEETING_UPDATE_CLAIM_LEASE_SECONDS,
    };
  } else {
    if (
      attempt.contentRevision !== input.expectedContentRevision ||
      !isDeepStrictEqual(pointersFor(row), attempt.expectedPointers) ||
      Object.entries(attempt.capturedParts).some(([part, captured]) => {
        const watermark = before.parts[presentationPartSchema.parse(part)];
        return (
          captured !== watermark.desired || captured <= watermark.acknowledged
        );
      })
    )
      return undefined;
    progress = {
      kind: "running",
      attempt,
      claim: {
        ownerInstanceId,
        leaseExpiresAt: now + MEETING_UPDATE_CLAIM_LEASE_SECONDS,
      },
      nextCheckAt: now + MEETING_UPDATE_CLAIM_LEASE_SECONDS,
      operations: attempt.operations.map((operation) => ({
        operationId: operation.operationId,
        submission: { kind: "prepared" },
      })),
    };
  }
  const after = meetingUpdateDeliverySchema.parse({
    ...before,
    revision: randomUUID(),
    progress,
  });
  assertMeetingUpdateDeliveryTransition(before, after);
  return after;
}
export function transitionDelivery(
  row: MeetingHistory,
  input: MeetingDeliveryTransition,
): MeetingUpdateDelivery | undefined {
  const before = row.updateDelivery;
  if (!before || before.revision !== input.expectedDeliveryRevision)
    return undefined;
  const progress = before.progress;
  if ("attempt" in progress) {
    if (
      progress.attempt.attemptId !== input.attemptId ||
      progress.claim.ownerInstanceId !== input.ownerInstanceId
    )
      return undefined;
  } else if (input.attemptId !== null || input.ownerInstanceId !== null)
    return undefined;
  if (input.change.kind === "progress" && "attempt" in input.change.progress) {
    if (!("attempt" in progress))
      throw new Error("New claims require transactional admission");
    if (
      input.change.progress.claim.ownerInstanceId !==
      progress.claim.ownerInstanceId
    )
      throw new Error("Claim owner changes require transactional admission");
  }
  return applyDeliveryChange(before, input.change);
}
export function canRegisterPointers(
  row: MeetingHistory,
  input: MeetingPointerRegistration,
): boolean {
  notesPointersSchema.parse(input.expectedPointers);
  notesPointersSchema.parse(input.nextPointers);
  if (
    !contentMatches(row, input) ||
    !isDeepStrictEqual(pointersFor(row), input.expectedPointers)
  )
    return false;
  const progress = row.updateDelivery
    ? meetingUpdateDeliverySchema.parse(row.updateDelivery).progress
    : undefined;
  if (
    !progress ||
    !("attempt" in progress) ||
    progress.attempt.attemptId !== input.attemptId ||
    progress.attempt.contentRevision !== input.expectedContentRevision
  )
    return false;
  return progress.attempt.operations.some((operation, index) => {
    if (
      operation.kind !== "register" ||
      progress.operations[index].submission.kind === "prepared" ||
      progress.operations[index].submission.kind === "rejected" ||
      !isDeepStrictEqual(operation.expectedPointers, input.expectedPointers) ||
      operation.notesChannelId !== input.nextPointers.notesChannelId
    )
      return false;
    const ids = operation.slots.map((slot) => {
      if (slot.kind === "existing") return slot.messageId;
      const postIndex = progress.attempt.operations.findIndex(
        (op) =>
          op.operationId === slot.operationId &&
          op.kind === "post" &&
          op.channelId === operation.notesChannelId,
      );
      const result = progress.operations[postIndex]?.submission;
      return result?.kind === "verified" && result.receipt.kind === "message"
        ? result.receipt.messageId
        : undefined;
    });
    return isDeepStrictEqual(ids, input.nextPointers.notesMessageIds);
  });
}
const changedFields = [
  "notes",
  "notesDelta",
  "notesVersion",
  "notesLastEditedBy",
  "notesLastEditedAt",
  "notesHistory",
  "suggestionsHistory",
  "meetingName",
  "summarySentence",
  "summaryLabel",
  "contentRevision",
  "contentMutation",
  "updatedAt",
  "updateDelivery",
  "updateDeliveryQueue",
  "updateDeliveryDueAt",
  "notesChannelId",
  "notesMessageIds",
] as const;
type WriteOptions = {
  authority?: WorkAdmissionAuthority;
  registerPointers?: boolean;
};
function conditionalUpdate(
  table: string,
  before: MeetingHistory,
  after: MeetingHistory,
  registerPointers: boolean,
): UpdateItemCommandInput & {
  UpdateExpression: string;
  TableName: string;
  Key: NonNullable<UpdateItemCommandInput["Key"]>;
} {
  const names: Record<string, string> = {
    "#delivery": "updateDelivery",
    "#revision": "revision",
    "#content": "contentRevision",
  };
  const values: Record<string, unknown> = {
    ":meeting": before.meetingId,
    ":content": before.contentRevision ?? 0,
  };
  const conditions = [
    "attribute_exists(guildId)",
    "attribute_exists(channelId_timestamp)",
    "meetingId = :meeting",
    before.contentRevision === undefined
      ? "attribute_not_exists(#content)"
      : "#content = :content",
  ];
  if (before.contentRevision === undefined) delete values[":content"];
  if (before.updateDelivery) {
    conditions.push("#delivery.#revision = :delivery");
    values[":delivery"] = before.updateDelivery.revision;
  } else {
    conditions.push("attribute_not_exists(#delivery)");
    delete names["#revision"];
  }
  if (before.updateDelivery && "attempt" in before.updateDelivery.progress) {
    Object.assign(names, {
      "#progress": "progress",
      "#attempt": "attempt",
      "#attemptId": "attemptId",
      "#claim": "claim",
      "#owner": "ownerInstanceId",
    });
    values[":attempt"] = before.updateDelivery.progress.attempt.attemptId;
    values[":owner"] = before.updateDelivery.progress.claim.ownerInstanceId;
    conditions.push(
      "#delivery.#progress.#attempt.#attemptId = :attempt",
      "#delivery.#progress.#claim.#owner = :owner",
    );
  }
  for (const field of ["notesChannelId", "notesMessageIds"] as const) {
    const name = "#old" + field;
    names[name] = field;
    if (before[field] === undefined)
      conditions.push("attribute_not_exists(" + name + ")");
    else {
      conditions.push(name + " = :old" + field);
      values[":old" + field] = before[field];
    }
  }
  const publication = publicationSnapshotCondition(publicationSnapshot(before));
  Object.assign(names, publication.names);
  Object.assign(values, publication.values);
  conditions.push(publication.condition);
  const set: string[] = [],
    remove: string[] = [];
  changedFields.forEach((field, index) => {
    if (
      isDeepStrictEqual(before[field], after[field]) &&
      !(registerPointers && field === "notesMessageIds")
    )
      return;
    const name = "#f" + index,
      value = ":f" + index;
    names[name] = field;
    if (after[field] === undefined) remove.push(name);
    else {
      set.push(name + " = " + value);
      values[value] = after[field];
    }
    // Preserve history/provenance and pointer snapshots even when legacy writers race.
    if (
      [
        "notesHistory",
        "suggestionsHistory",
        "notesVersion",
        "notesChannelId",
        "notesMessageIds",
      ].includes(field)
    ) {
      if (before[field] === undefined)
        conditions.push("attribute_not_exists(" + name + ")");
      else {
        conditions.push(name + " = :old" + index);
        values[":old" + index] = before[field];
      }
    }
  });
  return {
    TableName: table,
    Key: marshall({
      guildId: before.guildId,
      channelId_timestamp: before.channelId_timestamp,
    }),
    ConditionExpression: conditions.join(" AND "),
    UpdateExpression: [
      set.length ? "SET " + set.join(", ") : "",
      remove.length ? "REMOVE " + remove.join(", ") : "",
    ]
      .filter(Boolean)
      .join(" "),
    ExpressionAttributeNames: names,
    ExpressionAttributeValues: marshall(values, {
      removeUndefinedValues: true,
    }),
    ReturnValues: "ALL_NEW",
  };
}
const ackError = z.object({
  name: z.enum([
    "TimeoutError",
    "RequestTimeout",
    "RequestTimeoutException",
    "NetworkingError",
    "AbortError",
    "InternalServerError",
  ]),
  message: z.string().optional(),
});
const ambiguousServiceWrite = z.object({
  $metadata: z.object({ httpStatusCode: z.literal(500) }),
});
export function mayHaveCommitted(error: unknown): boolean {
  // DynamoDB HTTP 500 writes may have committed despite the service error.
  return (
    ackError.safeParse(error).success ||
    ambiguousServiceWrite.safeParse(error).success
  );
}
export function createDynamoMeetingUpdateDeliveryRepository(
  client: DynamoDBClient,
  tables: ControlTableNames,
): MeetingUpdateDeliveryRepository {
  async function getStrong(key: MeetingUpdateKey, signal?: AbortSignal) {
    const parsed = meetingUpdateKeySchema.parse(key);
    const result = await client.send(
      new GetItemCommand({
        TableName: tables.meetingHistory,
        Key: marshall(parsed),
        ConsistentRead: true,
      }),
      { abortSignal: signal },
    );
    if (!result.Item) return undefined;
    const history = parseMeetingUpdateHistory(unmarshall(result.Item));
    if (
      history.guildId !== parsed.guildId ||
      history.channelId_timestamp !== parsed.channelId_timestamp
    )
      throw new Error("Stored meeting identity mismatch");
    return history;
  }
  async function readAfterWriteError(key: MeetingUpdateKey, error: unknown) {
    try {
      return await getStrong(key);
    } catch (readError) {
      if (mayHaveCommitted(error)) throw error;
      throw readError;
    }
  }
  async function persist(
    before: MeetingHistory,
    after: MeetingHistory,
    signal?: AbortSignal,
    options: WriteOptions = {},
  ): Promise<MeetingHistory> {
    assertMeetingItemSize(after);
    const update = conditionalUpdate(
      tables.meetingHistory,
      before,
      after,
      options.registerPointers ?? false,
    );
    const authority = options.authority;
    if (authority) {
      const { ReturnValues, ...transactionUpdate } = update;
      void ReturnValues;
      await client.send(
        new TransactWriteItemsCommand({
          TransactItems: [
            ...buildWorkAdmissionChecks(authority, tables),
            { Update: transactionUpdate },
          ],
        }),
        { abortSignal: signal },
      );
      return after;
    }
    const result = await client.send(new UpdateItemCommand(update), {
      abortSignal: signal,
    });
    if (!result.Attributes) throw new Error("Missing ALL_NEW meeting result");
    return parseMeetingUpdateHistory(unmarshall(result.Attributes));
  }
  async function writeDelivery(
    row: MeetingHistory,
    next: MeetingHistory,
    signal?: AbortSignal,
    options: WriteOptions = {},
  ): Promise<"applied" | "stale"> {
    try {
      await persist(row, next, signal, options);
      return "applied";
    } catch (error) {
      const kind = classifyDeploymentTransactionError(error);
      if (kind !== "stale" && !mayHaveCommitted(error)) throw error;
      const actual = await readAfterWriteError(
        {
          guildId: row.guildId,
          channelId_timestamp: row.channelId_timestamp,
        },
        error,
      );
      if (
        actual &&
        isDeepStrictEqual(actual.updateDelivery, next.updateDelivery) &&
        isDeepStrictEqual(pointersFor(actual), pointersFor(next))
      )
        return "applied";
      if (kind === "stale") return "stale";
      throw error;
    }
  }
  return {
    getStrong,
    async updateContentAndDelivery(input, signal) {
      const row = await getStrong(input.key, signal);
      if (isExactContentMutation(row, input))
        return { kind: "committed", history: row };
      if (!canCompareContentWrite(row, input)) return { kind: "conflict" };
      const next = prepareContentWrite(row, input);
      try {
        const saved = await persist(row, next, signal);
        return { kind: "committed", history: saved };
      } catch (error) {
        const kind = classifyDeploymentTransactionError(error);
        if (kind !== "stale" && !mayHaveCommitted(error)) throw error;
        const actual = await readAfterWriteError(input.key, error);
        if (isExactContentMutation(actual, input))
          return { kind: "committed", history: actual };
        if (kind === "stale") return { kind: "conflict" };
        throw error;
      }
    },
    async listDue(input) {
      const cursor = validateDue(input);
      const result = await client.send(
        new QueryCommand({
          TableName: tables.meetingHistory,
          IndexName: MEETING_UPDATE_DELIVERY_DUE_INDEX,
          KeyConditionExpression:
            "updateDeliveryQueue = :queue AND updateDeliveryDueAt <= :now",
          ExpressionAttributeValues: marshall({
            ":queue": MEETING_UPDATE_DELIVERY_QUEUE,
            ":now": input.now,
          }),
          Limit: input.limit,
          ExclusiveStartKey: cursor ? marshall(cursor) : undefined,
        }),
        { abortSignal: input.signal },
      );
      return {
        keys: (result.Items ?? []).map((item) =>
          meetingUpdateKeySchema.parse({
            guildId: unmarshall(item).guildId,
            channelId_timestamp: unmarshall(item).channelId_timestamp,
          }),
        ),
        ...(result.LastEvaluatedKey
          ? {
              cursor: writeMeetingUpdateDeliveryCursor(
                meetingUpdateDeliveryCursorSchema.parse(
                  unmarshall(result.LastEvaluatedKey),
                ),
              ),
            }
          : {}),
      };
    },
    async claim(input) {
      const row = await getStrong(input.key, input.signal);
      if (!row) return "stale";
      const delivery = claimDelivery(row, input);
      if (!delivery) return "stale";
      return (await writeDelivery(
        row,
        withDelivery(row, delivery),
        input.signal,
        { authority: input.authority },
      )) === "applied"
        ? "claimed"
        : "stale";
    },
    async transition(input) {
      const row = await getStrong(input.key, input.signal);
      if (!row) return "stale";
      const next = transitionDelivery(row, input);
      return next
        ? writeDelivery(row, withDelivery(row, next), input.signal)
        : "stale";
    },
    async registerNotesPointers(input) {
      const row = await getStrong(input.key, input.signal);
      if (!row || !canRegisterPointers(row, input)) return "stale";
      const next = {
        ...row,
        notesMessageIds: input.nextPointers.notesMessageIds,
        notesChannelId: input.nextPointers.notesChannelId ?? undefined,
      };
      return writeDelivery(row, next, input.signal, { registerPointers: true });
    },
  };
}
