import type { TransactWriteItemsCommandInput } from "@aws-sdk/client-dynamodb";
import { marshall } from "@aws-sdk/util-dynamodb";
import { z } from "zod";
import type { PersonalMediaUploadJobRecord } from "../types/db";
import {
  controlRecordSchema,
  pausedDesktopDraftRecordSchema,
  type ControlTableNames,
  type PausedDesktopDraftInstallation,
} from "../types/deploymentControl";
import { snapshotCondition } from "./deploymentControlTransactions";

const parentOptionalFields = [
  "uploadOrigin",
  "sourceManifest",
  "originalFileName",
  "title",
  "tags",
  "meetingGuildId",
  "meetingId",
  "channelId_timestamp",
  "errorMessage",
  "retryable",
  "attempts",
  "processingClaimId",
  "artifactAttempts",
  "queuedAt",
  "processingStartedAt",
  "processingOwnerInstanceId",
  "claimExpiresAt",
  "durationSeconds",
  "segmentCount",
  "uploadedSegmentCount",
  "processedSegmentCount",
  "completedAt",
  "expiresAt",
] satisfies (keyof PersonalMediaUploadJobRecord)[];
function expectedParentCondition(parent: PersonalMediaUploadJobRecord) {
  const names: Record<string, string> = {};
  const values: Record<string, unknown> = {};
  const fields = [
    ...new Set([...Object.keys(parent), ...parentOptionalFields]),
  ];
  const conditions = fields.map((field, index) => {
    const name = `#p${index}`;
    names[name] = field;
    const value = Object.entries(parent).find(([key]) => key === field)?.[1];
    if (value === undefined) return `attribute_not_exists(${name})`;
    values[`:p${index}`] = value;
    return `${name} = :p${index}`;
  });
  return {
    ConditionExpression: conditions.join(" AND "),
    ExpressionAttributeNames: names,
    ExpressionAttributeValues: marshall(values),
  };
}

function validateInstallationAuthority(
  control: ReturnType<typeof controlRecordSchema.parse>,
  input: PausedDesktopDraftInstallation,
) {
  if (
    Object.keys(control.servingMembers).length ||
    control.coordinatorToken !== input.coordinatorToken ||
    control.coordinatorEpoch !== input.coordinatorEpoch ||
    control.coordinatorExpiresAt <= input.now
  )
    throw new Error(
      "Paused draft installation requires exact unexpired authority and closed admission",
    );
}

function validatePausedDraftParent({
  record,
  expectedParent: parent,
}: PausedDesktopDraftInstallation["pairs"][number]) {
  pausedDesktopDraftRecordSchema.parse(record);
  if (
    record.uploadId !== parent.uploadId ||
    record.ownerUserId !== parent.ownerUserId ||
    parent.uploadOrigin !== "desktop_recording" ||
    !["pending_upload", "queued"].includes(parent.status) ||
    parent.processingClaimId !== undefined ||
    parent.processingOwnerInstanceId !== undefined ||
    parent.claimExpiresAt !== undefined ||
    parent.processingStartedAt !== undefined ||
    (parent.attempts ?? 0) !== 0 ||
    parent.artifactAttempts !== undefined
  )
    throw new Error("Paused draft parent binding or processing state mismatch");
}

/** Capture provenance and legacy/effect settlement belong to the protected installer, not this CAS. */
export function buildPausedDesktopDraftInstallationTransaction(
  input: PausedDesktopDraftInstallation,
  tables: ControlTableNames,
): TransactWriteItemsCommandInput {
  const control = controlRecordSchema.parse(input.control);
  z.number().int().nonnegative().parse(input.now);
  if (!tables.personalMediaUpload)
    throw new Error("Personal upload table is required");
  validateInstallationAuthority(control, input);
  if (input.pairs.length !== 2)
    throw new Error("Exactly two paused drafts are required");
  const [first, second] = input.pairs;
  if (
    first.record.uploadId === second.record.uploadId ||
    first.record.operationId !== second.record.operationId ||
    first.record.manifestSha256 !== second.record.manifestSha256 ||
    first.record.preservedCaptureSha256 !== second.record.preservedCaptureSha256
  )
    throw new Error("Paused draft cohort binding mismatch");
  for (const pair of input.pairs) validatePausedDraftParent(pair);
  return {
    TransactItems: [
      {
        ConditionCheck: {
          TableName: tables.deploymentControl,
          Key: marshall({ pk: control.pk, sk: control.sk }),
          ...snapshotCondition(control),
        },
      },
      ...input.pairs.map(({ expectedParent }) => ({
        ConditionCheck: {
          TableName: tables.personalMediaUpload,
          Key: marshall({ uploadId: expectedParent.uploadId }),
          ...expectedParentCondition(expectedParent),
        },
      })),
      ...input.pairs.map(({ record }) => ({
        Put: {
          TableName: tables.deploymentControl,
          Item: marshall(record),
          ConditionExpression: "attribute_not_exists(pk)",
        },
      })),
    ],
  };
}
