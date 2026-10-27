import { z } from "zod";
import { marshall } from "@aws-sdk/util-dynamodb";
import type { TransactWriteItem } from "@aws-sdk/client-dynamodb";
import { pausedDesktopDraftRecordSchema } from "../types/deploymentControl";
import { snapshotCondition } from "./productionAcceptanceConditions";

const text = z.string().min(1);
const count = z.number().int().nonnegative().safe();
const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const pausedInitializationDigestsSchema = z
  .object({
    cohortSha256: hash,
    captureSha256: hash,
    policyScopeSha256: hash,
  })
  .strict();
const sourceSchema = z
  .object({
    sourceId: text,
    kind: z.enum(["owner_mic", "system_output"]),
    sourceS3Key: text.optional(),
    contentType: text.optional(),
    fileSize: count.optional(),
  })
  .strict();
const identity = { uploadId: text, ownerUserId: text };
const parentSchema = z
  .object({
    ...identity,
    status: z.enum(["pending_upload", "queued"]),
    mediaKind: z.literal("audio"),
    uploadOrigin: z.literal("desktop_recording"),
    sourceS3Key: text,
    sourceManifest: z.array(sourceSchema).min(1).max(4),
    contentType: text,
    fileSize: count,
    createdAt: text,
    updatedAt: text,
    attempts: z.literal(0).optional(),
    retryable: z.boolean().optional(),
    queuedAt: text.optional(),
    expiresAt: count.optional(),
    durationSeconds: z.number().nonnegative().optional(),
    segmentCount: count,
    uploadedSegmentCount: count,
    processedSegmentCount: z.literal(0).optional(),
  })
  .strict();
const segmentSchema = z
  .object({
    ...identity,
    segmentKey: text,
    sourceId: text,
    sequence: count,
    kind: z.enum(["owner_mic", "system_output"]),
    sourceS3Key: text,
    contentType: text,
    fileSize: count.positive(),
    checksumSha256: hash,
    durationMillis: count,
    startedAt: text,
    endedAt: text,
    status: z.enum(["pending_upload", "uploaded", "submitted"]),
    createdAt: text,
    updatedAt: text,
    uploadedAt: text.optional(),
    submittedAt: text.optional(),
  })
  .strict();
export const pausedInitializationSchema = pausedInitializationDigestsSchema
  .extend({
    parents: z.tuple([parentSchema, parentSchema]),
    segments: z.array(segmentSchema),
    markers: z.tuple([
      pausedDesktopDraftRecordSchema,
      pausedDesktopDraftRecordSchema,
    ]),
  })
  .strict();
export type PausedInitializationGuards = z.infer<
  typeof pausedInitializationSchema
>;

const forbiddenParent = [
  "processingClaimId",
  "processingOwnerInstanceId",
  "claimExpiresAt",
  "processingStartedAt",
  "artifactAttempts",
  "meetingGuildId",
  "meetingId",
  "channelId_timestamp",
  "completedAt",
];
const forbiddenSegment = ["processedAt", "transcriptS3Key"];
function parentCondition(table: string, row: z.infer<typeof parentSchema>) {
  const fields = Object.keys(parentSchema.shape).filter(
    (field) => field !== "sourceManifest",
  );
  const condition = snapshotCondition(table, { uploadId: row.uploadId }, row, [
    ...fields,
    ...forbiddenParent,
  ]);
  return indexedPausedSourceCondition(condition, row.sourceManifest);
}
export function indexedPausedSourceCondition(
  condition: NonNullable<TransactWriteItem["ConditionCheck"]>,
  input: unknown,
) {
  const sources = z.array(sourceSchema).min(1).max(4).parse(input);
  const names = {
    ...condition.ExpressionAttributeNames,
    "#manifest": "sourceManifest",
  };
  const values = {
    ...condition.ExpressionAttributeValues,
    ...marshall({
      ":listType": "L",
      ":sourceCount": sources.length,
    }),
  };
  const sourceConditions = [
    "attribute_type(#manifest, :listType)",
    "size(#manifest) = :sourceCount",
  ];
  sources.forEach((source, index) => {
    for (const field of Object.keys(sourceSchema.shape)) {
      const alias = `#${field}`;
      Object.assign(names, { [alias]: field });
      const path = `#manifest[${index}].${alias}`,
        value = Reflect.get(source, field);
      if (value === undefined)
        sourceConditions.push(`attribute_not_exists(${path})`);
      else {
        const key = `:source${index}_${field}`;
        Object.assign(values, marshall({ [key]: value }));
        sourceConditions.push(`${path} = ${key}`);
      }
    }
  });
  return {
    ...condition,
    ConditionExpression: [
      condition.ConditionExpression,
      ...sourceConditions,
    ].join(" AND "),
    ExpressionAttributeNames: names,
    ExpressionAttributeValues: values,
  };
}
function assertCohort(
  value: PausedInitializationGuards,
  binding: { operationId: string; manifestHash: string },
) {
  if (
    value.parents[0].uploadId === value.parents[1].uploadId ||
    new Set(value.segments.map((row) => `${row.uploadId}/${row.segmentKey}`))
      .size !== value.segments.length
  )
    throw Error("paused_initialization_refused");
  value.parents.forEach((parent, index) =>
    assertParentBinding(value, parent, index, binding),
  );
  for (const segment of value.segments) {
    const parent = value.parents.find(
      (row) => row.uploadId === segment.uploadId,
    );
    if (
      !parent ||
      parent.ownerUserId !== segment.ownerUserId ||
      !parent.sourceManifest.some(
        (source) =>
          source.sourceId === segment.sourceId && source.kind === segment.kind,
      )
    )
      throw Error("paused_initialization_refused");
  }
}
function assertParentBinding(
  value: PausedInitializationGuards,
  parent: z.infer<typeof parentSchema>,
  index: number,
  binding: { operationId: string; manifestHash: string },
) {
  const marker = value.markers[index],
    parts = value.segments.filter((row) => row.uploadId === parent.uploadId);
  if (
    marker.uploadId !== parent.uploadId ||
    marker.ownerUserId !== parent.ownerUserId ||
    marker.operationId !== binding.operationId ||
    marker.manifestSha256 !== binding.manifestHash ||
    marker.preservedCaptureSha256 !== value.captureSha256 ||
    parent.segmentCount !== parts.length ||
    parent.uploadedSegmentCount !==
      parts.filter((row) => ["uploaded", "submitted"].includes(row.status))
        .length ||
    new Set(parent.sourceManifest.map((row) => row.sourceId)).size !==
      parent.sourceManifest.length
  )
    throw Error("paused_initialization_refused");
}
export function buildPausedInitializationItems(
  input: unknown,
  binding: { operationId: string; manifestHash: string },
  tables: {
    deploymentControl: string;
    personalJob?: string;
    personalSegment?: string;
  },
): TransactWriteItem[] {
  const value = pausedInitializationSchema.parse(input);
  assertCohort(value, binding);
  const { personalJob, personalSegment } = tables;
  if (!personalJob || !personalSegment)
    throw Error("paused_initialization_refused");
  return [
    ...value.parents.map((row) => ({
      ConditionCheck: parentCondition(personalJob, row),
    })),
    ...value.segments.map((row) => ({
      ConditionCheck: snapshotCondition(
        personalSegment,
        { uploadId: row.uploadId, segmentKey: row.segmentKey },
        row,
        [...Object.keys(segmentSchema.shape), ...forbiddenSegment],
      ),
    })),
    ...value.markers.map((row) => ({
      Put: {
        TableName: tables.deploymentControl,
        Item: marshall(row),
        ConditionExpression: "attribute_not_exists(pk)",
      },
    })),
  ];
}
