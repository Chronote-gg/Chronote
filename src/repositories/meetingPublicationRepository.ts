import { isDeepStrictEqual } from "node:util";
import {
  DynamoDBClient,
  GetItemCommand,
  UpdateItemCommand,
} from "@aws-sdk/client-dynamodb";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";
import type { MeetingHistory } from "../types/db";
import {
  meetingUpdateDeliverySchema,
  presentationPartSchema,
  type MeetingUpdateKey,
} from "../types/meetingUpdateDelivery";
import {
  publicationSnapshot,
  publicationSnapshotCondition,
  matchesPublicationSnapshot,
  publicationSnapshotDigest,
  originalPublicationUnsettled,
  repairPublicationOwnerSchema,
  type MeetingPublicationSnapshot,
  type RepairPublicationOwner,
} from "../types/meetingPublication";
import {
  parseMeetingUpdateHistory,
  assertMeetingItemSize,
  withDelivery,
} from "./meetingUpdateDeliveryState";
import { classifyDeploymentTransactionError } from "./deploymentControlRepository";
import { mayHaveCommitted } from "./meetingUpdateDeliveryRepository";
type Acquisition = {
  key: MeetingUpdateKey;
  expected: MeetingPublicationSnapshot;
  owner: RepairPublicationOwner;
};
export type RepairSettlement = {
  owner: RepairPublicationOwner;
  evidence:
    { kind: "known_settled" } | { kind: "confirmed_stopped"; runId: string };
  adoptVerified: boolean;
};
export type MeetingPublicationRepository = {
  getStrong(key: MeetingUpdateKey): Promise<MeetingHistory | undefined>;
  acquireRepair(input: Acquisition): Promise<"owned" | "stale">;
  settleRepair(
    input: RepairSettlement & { key: MeetingUpdateKey },
  ): Promise<"applied" | "stale">;
};
type Store = Pick<MeetingPublicationRepository, "getStrong"> & {
  commit(
    before: MeetingHistory,
    after: MeetingHistory,
  ): Promise<"applied" | "stale">;
};
function canAcquire(row: MeetingHistory, input: Acquisition) {
  return (
    matchesPublicationSnapshot(row, input.expected) &&
    input.owner.kind === "running" &&
    publicationSnapshotDigest(row) === input.owner.snapshot &&
    !originalPublicationUnsettled(publicationSnapshot(row)) &&
    !(row.updateDelivery && "attempt" in row.updateDelivery.progress) &&
    row.publicationRepair?.kind !== "running"
  );
}
function settledRepairRow(
  row: MeetingHistory,
  input: RepairSettlement,
): MeetingHistory {
  const owner = repairPublicationOwnerSchema.parse(input.owner);
  if (
    input.evidence.kind === "confirmed_stopped" &&
    input.evidence.runId !== owner.runId
  )
    throw new Error(
      "Stopped-run assertion must identify the exact database owner",
    );
  let next: MeetingHistory = {
    ...row,
    publicationRepair: { ...owner, kind: "settled" },
  };
  const delivery = next.updateDelivery;
  if (!delivery) {
    if (
      !input.adoptVerified ||
      publicationSnapshotDigest(row) !== owner.snapshot ||
      (!row.notesChannelId && !row.summaryMessageId)
    )
      return next;
    // This exact successful repair establishes enrollment, not an update attempt
    // or a claim that any future canonical revision has already converged.
    return withDelivery(
      next,
      meetingUpdateDeliverySchema.parse({
        revision: "adopted-" + owner.previewDigest,
        policy: { kind: "active" },
        parts: Object.fromEntries(
          presentationPartSchema.options.map((part) => [
            part,
            { desired: 0, acknowledged: 0 },
          ]),
        ),
        progress: { kind: "synced", syncedAt: Math.floor(Date.now() / 1000) },
      }),
    );
  }
  if (
    input.adoptVerified &&
    publicationSnapshotDigest(row) === owner.snapshot &&
    delivery.policy.kind === "held" &&
    delivery.policy.reason === "legacy_publication_unknown"
  )
    next = {
      ...next,
      updateDelivery: {
        ...delivery,
        revision: "adopted-" + owner.previewDigest,
        policy: { kind: "active" },
      },
    };
  return withDelivery(next, next.updateDelivery ?? delivery);
}
export function createMeetingPublicationRepository(
  store: Store,
): MeetingPublicationRepository {
  return {
    getStrong: store.getStrong,
    async acquireRepair(input) {
      repairPublicationOwnerSchema.parse(input.owner);
      const row = await store.getStrong(input.key);
      if (!row) return "stale";
      if (
        isDeepStrictEqual(row.publicationRepair, input.owner) &&
        publicationSnapshotDigest(row) === input.owner.snapshot
      )
        return "owned";
      if (!canAcquire(row, input)) return "stale";
      const next = { ...row, publicationRepair: input.owner };
      delete next.updateDeliveryQueue;
      delete next.updateDeliveryDueAt;
      return (await store.commit(row, next)) === "applied" ? "owned" : "stale";
    },
    async settleRepair(input) {
      const row = await store.getStrong(input.key);
      if (!row) return "stale";
      if (
        isDeepStrictEqual(row.publicationRepair, {
          ...input.owner,
          kind: "settled",
        })
      )
        return "applied";
      if (!isDeepStrictEqual(row.publicationRepair, input.owner))
        return "stale";
      return store.commit(row, settledRepairRow(row, input));
    },
  };
}
const fields = [
  "publicationRepair",
  "updateDelivery",
  "updateDeliveryQueue",
  "updateDeliveryDueAt",
] as const;
function repairUpdate(
  table: string,
  before: MeetingHistory,
  after: MeetingHistory,
) {
  const proof = publicationSnapshotCondition(publicationSnapshot(before));
  const set: string[] = [],
    remove: string[] = [];
  fields.forEach((field, index) => {
    const name = "#repair" + index,
      value = ":repair" + index;
    proof.names[name] = field;
    if (after[field] === undefined) remove.push(name);
    else {
      set.push(name + " = " + value);
      proof.values[value] = after[field];
    }
  });
  return {
    TableName: table,
    Key: marshall({
      guildId: before.guildId,
      channelId_timestamp: before.channelId_timestamp,
    }),
    ConditionExpression:
      "attribute_exists(guildId) AND attribute_exists(channelId_timestamp) AND " +
      proof.condition,
    UpdateExpression: [
      set.length ? "SET " + set.join(", ") : "",
      remove.length ? "REMOVE " + remove.join(", ") : "",
    ]
      .filter(Boolean)
      .join(" "),
    ExpressionAttributeNames: proof.names,
    ExpressionAttributeValues: marshall(proof.values, {
      removeUndefinedValues: true,
    }),
  };
}
export function createDynamoMeetingPublicationRepository(
  client: DynamoDBClient,
  table: string,
): MeetingPublicationRepository {
  async function getStrong(key: MeetingUpdateKey) {
    const result = await client.send(
      new GetItemCommand({
        TableName: table,
        Key: marshall(key),
        ConsistentRead: true,
      }),
    );
    return result.Item
      ? parseMeetingUpdateHistory(unmarshall(result.Item))
      : undefined;
  }
  return createMeetingPublicationRepository({
    getStrong,
    async commit(before, after) {
      assertMeetingItemSize(after);
      try {
        await client.send(
          new UpdateItemCommand(repairUpdate(table, before, after)),
        );
        return "applied";
      } catch (error) {
        const stale = classifyDeploymentTransactionError(error) === "stale";
        if (!stale && !mayHaveCommitted(error)) throw error;
        let actual: MeetingHistory | undefined;
        try {
          actual = await getStrong({
            guildId: before.guildId,
            channelId_timestamp: before.channelId_timestamp,
          });
        } catch {
          throw error;
        }
        if (
          actual &&
          matchesPublicationSnapshot(actual, publicationSnapshot(after))
        )
          return "applied";
        if (stale) return "stale";
        throw error;
      }
    },
  });
}
export function createMockMeetingPublicationRepository(
  histories: Map<string, MeetingHistory[]>,
): MeetingPublicationRepository {
  function row(key: MeetingUpdateKey) {
    return histories
      .get(key.guildId)
      ?.find((item) => item.channelId_timestamp === key.channelId_timestamp);
  }
  return createMeetingPublicationRepository({
    async getStrong(key) {
      const current = row(key);
      return current
        ? parseMeetingUpdateHistory(JSON.parse(JSON.stringify(current)))
        : undefined;
    },
    async commit(before, after) {
      const current = row(before);
      if (
        !current ||
        !matchesPublicationSnapshot(current, publicationSnapshot(before))
      )
        return "stale";
      assertMeetingItemSize(after);
      for (const field of fields) {
        if (after[field] === undefined) delete current[field];
        else
          Object.assign(current, {
            [field]: JSON.parse(JSON.stringify(after[field])),
          });
      }
      return "applied";
    },
  });
}
