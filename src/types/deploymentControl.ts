import { z } from "zod";

export type {
  CheckpointPublication,
  ControlTableNames,
  HistoryKey,
  HistoryTransition,
  SessionReservation,
} from "./meetingHistoryTransition";

const id = z.string().min(1);
const epochSecond = z.number().int().nonnegative();
const identityFields = { instanceId: id, protocolVersion: z.literal(1) };
export const runtimeIdentitySchema = z.discriminatedUnion("kind", [
  z
    .object({ ...identityFields, kind: z.literal("local"), localId: id })
    .strict(),
  z
    .object({
      ...identityFields,
      kind: z.literal("ecs"),
      taskArn: id,
      imageDigest: id,
      candidateId: id,
    })
    .strict(),
]);
export type RuntimeIdentity = z.infer<typeof runtimeIdentitySchema>;
export const suppressionRecordSchema = z
  .object({
    pk: id,
    sk: id,
    recordType: z.literal("suppression"),
    protocolVersion: z.literal(1),
    guildId: id,
    channelId: id,
    meetingId: id,
    createdAt: epochSecond,
    version: z.number().int().positive(),
    suppressed: z.boolean(),
    reason: z.enum(["explicit_end", "forced_disconnect"]),
  })
  .strict()
  .refine(
    (row) =>
      row.pk === `SUPPRESS#${row.guildId}` &&
      row.sk === `CHANNEL#${row.channelId}`,
    "Suppression key does not match scope",
  );
export type SuppressionRecord = z.infer<typeof suppressionRecordSchema>;
export const pausedDesktopDraftKey = (uploadId: string) => ({
  pk: `UPLOAD#${id.parse(uploadId)}`,
  sk: "PAUSED_DRAFT",
});
export const pausedDesktopDraftRecordSchema = z
  .object({
    pk: id,
    sk: z.literal("PAUSED_DRAFT"),
    recordType: z.literal("paused_desktop_draft"),
    protocolVersion: z.literal(1),
    uploadId: id,
    ownerUserId: id,
    operationId: id,
    manifestSha256: z.string().regex(/^[a-f0-9]{64}$/),
    preservedCaptureSha256: z.string().regex(/^[a-f0-9]{64}$/),
    createdAt: epochSecond,
  })
  .strict()
  .refine(
    (row) => row.pk === pausedDesktopDraftKey(row.uploadId).pk,
    "Paused draft key does not match upload",
  );
export type PausedDesktopDraftRecord = z.infer<
  typeof pausedDesktopDraftRecordSchema
>;
/** The records this table holds that a remaining reader looks up by key. */
const deploymentControlRecordSchema = z.union([
  suppressionRecordSchema,
  pausedDesktopDraftRecordSchema,
]);
export type DeploymentControlRecord = z.infer<
  typeof deploymentControlRecordSchema
>;
export const parseDeploymentControlRecord = (
  value: unknown,
): DeploymentControlRecord => deploymentControlRecordSchema.parse(value);
