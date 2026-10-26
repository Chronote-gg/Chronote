import { context, control, promotion, runtime } from "./controlFixtures";
import {
  CreateTableCommand,
  DeleteTableCommand,
  UpdateItemCommand,
  TransactWriteItemsCommand,
} from "@aws-sdk/client-dynamodb";
import { marshall } from "@aws-sdk/util-dynamodb";
import type { MeetingHistory, PersonalMediaClaim } from "../../src/types/db";
import {
  buildPromotionTransaction,
  buildPersonalClaimCheck,
} from "../../src/services/deploymentControlTransactions";
import { createDynamoMeetingUpdateDeliveryRepository } from "../../src/repositories/meetingUpdateDeliveryRepository";
import { publicationDynamoFixture } from "./meetingPublicationDynamo.fixture";
import { history, key } from "../types/meetingUpdateDelivery.fixture";

export async function mixedVersionFixture() {
  const base = await publicationDynamoFixture();
  const tables = {
    ...base.tables,
    personalMediaUpload: base.tables.meetingHistory + "-personal",
  };
  try {
    await base.client.send(
      new CreateTableCommand({
        TableName: tables.personalMediaUpload,
        BillingMode: "PAY_PER_REQUEST",
        KeySchema: [{ AttributeName: "uploadId", KeyType: "HASH" }],
        AttributeDefinitions: [
          { AttributeName: "uploadId", AttributeType: "S" },
        ],
      }),
    );
  } catch (error) {
    await base.close();
    throw error;
  }
  return {
    ...base,
    tables,
    updates: createDynamoMeetingUpdateDeliveryRepository(base.client, tables),
    async close() {
      try {
        await base.client.send(
          new DeleteTableCommand({ TableName: tables.personalMediaUpload }),
        );
      } finally {
        await base.close();
      }
    },
  };
}
export type MixedVersionFixture = Awaited<
  ReturnType<typeof mixedVersionFixture>
>;
export function personalClaim(): PersonalMediaClaim {
  return {
    uploadId: "synthetic-upload",
    instanceId: "synthetic-feature-worker",
    attempt: 1,
    claimId: "synthetic-claim",
    nowEpochSeconds: Math.floor(Date.now() / 1000),
  };
}
export function personalJob(claim: PersonalMediaClaim) {
  return {
    uploadId: claim.uploadId,
    status: "processing" as const,
    ownerUserId: "synthetic-user",
    mediaKind: "audio" as const,
    sourceS3Key: "synthetic/source.mp3",
    contentType: "audio/mpeg",
    fileSize: 1,
    createdAt: "2026-01-01",
    updatedAt: "2026-01-01",
    processingOwnerInstanceId: claim.instanceId,
    attempts: claim.attempt,
    processingClaimId: claim.claimId,
    claimExpiresAt: claim.nowEpochSeconds + 3600,
  };
}
export const oldGenerated = {
  notes: "Old generated notes",
  notesVersion: 1,
  meetingName: "Old generated name",
  summarySentence: "Old generated sentence",
  summaryLabel: "Old generated label",
};
// Frozen pre-feature saveOwnedMeetingHistoryService / buildHistoryTransition shape.
// Ordinary terminal writes had these four predicates and no canonical revision check.
export async function oldRecordingTerminal(
  fixture: MixedVersionFixture,
  row: MeetingHistory,
) {
  const fields = Object.entries({
    ...oldGenerated,
    status: row.status === "cancelled" ? "cancelled" : "complete",
  });
  await fixture.client.send(
    new UpdateItemCommand({
      TableName: fixture.tables.meetingHistory,
      Key: marshall(key),
      UpdateExpression:
        "SET " + fields.map((_, i) => `#f${i} = :f${i}`).join(", "),
      ConditionExpression:
        "meetingId = :meeting AND ownerInstanceId = :owner AND executionVersion = :version AND #status = :prior",
      ExpressionAttributeNames: {
        "#status": "status",
        ...Object.fromEntries(fields.map(([name], i) => [`#f${i}`, name])),
      },
      ExpressionAttributeValues: marshall({
        ":meeting": row.meetingId,
        ":owner": row.ownerInstanceId,
        ":version": row.executionVersion,
        ":prior": row.status,
        ...Object.fromEntries(fields.map(([, value], i) => [`:f${i}`, value])),
      }),
    }),
  );
}
// Frozen pre-feature personal history update, composed with the complete claim check.
// The old writer omitted only identity/access/archive fields, not generated content.
export async function oldPersonalTerminal(
  fixture: MixedVersionFixture,
  row: MeetingHistory,
  claim: PersonalMediaClaim,
) {
  const fields = Object.entries({
    ...row,
    ...oldGenerated,
    status: "complete",
  }).filter(
    ([name, value]) =>
      value !== undefined &&
      ![
        "guildId",
        "channelId_timestamp",
        "accessGrants",
        "archivedAt",
        "archivedByUserId",
      ].includes(name),
  );
  await fixture.client.send(
    new TransactWriteItemsCommand({
      TransactItems: [
        buildPersonalClaimCheck(claim, fixture.tables.personalMediaUpload),
        {
          Update: {
            TableName: fixture.tables.meetingHistory,
            Key: marshall(key),
            UpdateExpression:
              "SET " + fields.map((_, i) => `#f${i} = :f${i}`).join(", "),
            ConditionExpression:
              "attribute_not_exists(guildId) OR (meetingId = :meeting AND ownerUserId = :owner AND ownershipScope = :personal AND #status = :processing)",
            ExpressionAttributeNames: {
              "#status": "status",
              ...Object.fromEntries(
                fields.map(([name], i) => [`#f${i}`, name]),
              ),
            },
            ExpressionAttributeValues: marshall(
              {
                ":meeting": row.meetingId,
                ":owner": row.ownerUserId,
                ":personal": "personal",
                ":processing": "processing",
                ...Object.fromEntries(
                  fields.map(([, value], i) => [`:f${i}`, value]),
                ),
              },
              { removeUndefinedValues: true },
            ),
          },
        },
      ],
    }),
  );
}

export function featurePersonalRow(claim: PersonalMediaClaim) {
  return {
    ...history(),
    status: "processing" as const,
    ownershipScope: "personal" as const,
    ownerUserId: "synthetic-user",
    canonicalWriter: {
      kind: "personal" as const,
      uploadId: claim.uploadId,
      instanceId: claim.instanceId,
      attempt: claim.attempt,
      claimId: claim.claimId,
    },
  };
}
export async function promoteWithRetainedPeer(
  fixture: MixedVersionFixture,
  now: number,
  capable: boolean,
) {
  const fresh = (id: string, role: "serving" | "candidate" = "serving") => {
    const row = runtime(id, role);
    return {
      ...row,
      heartbeatAt: now,
      readiness: { ...row.readiness, provenAt: now - 1, expiresAt: now + 3600 },
      protection: {
        ...row.protection,
        provenAt: now - 1,
        expiresAt: now + 3600,
      },
    };
  };
  const old = fresh("old"),
    retained = fresh("retained"),
    candidate = fresh("new", "candidate");
  const before = {
    ...control,
    coordinatorExpiresAt: now + 3600,
    servingMembers: { old: old.identity, retained: retained.identity },
  };
  await fixture.put(fixture.tables.deploymentControl, before);
  await fixture.put(fixture.tables.deploymentControl, old);
  await fixture.put(fixture.tables.deploymentControl, {
    ...retained,
    ...(capable ? { canonicalContentWriter: 1 } : {}),
  });
  await fixture.put(fixture.tables.deploymentControl, {
    ...candidate,
    canonicalContentWriter: 1,
  });
  await fixture.client.send(
    new TransactWriteItemsCommand(
      buildPromotionTransaction({
        ...promotion,
        tables: fixture.tables,
        now,
        expectedServingMembers: Object.values(before.servingMembers),
        candidate: candidate.identity,
        retainedMembers: [retained.identity],
      }),
    ),
  );
  return {
    retainedContext: {
      ...context,
      instanceId: "retained",
      identity: retained.identity,
      authorizedGeneration: 8,
      now,
    },
    promotedControl: {
      ...before,
      servingGeneration: 8,
      servingMembers: { new: candidate.identity, retained: retained.identity },
    },
    retainedWithoutCapability: {
      ...retained,
      authorizedGeneration: 8,
      readiness: { ...retained.readiness, observedGeneration: 8 },
    },
  };
}

export function beforeCanonicalWrite(
  fixture: MixedVersionFixture,
  name: string,
  effect: () => Promise<void>,
) {
  let armed = true;
  fixture.client.middlewareStack.add(
    (next, context) => async (args) => {
      if (
        armed &&
        ["UpdateItemCommand", "TransactWriteItemsCommand"].includes(
          context.commandName ?? "",
        )
      ) {
        armed = false;
        await effect();
      }
      return next(args);
    },
    { step: "initialize", name },
  );
  return () => armed;
}
