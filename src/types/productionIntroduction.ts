import { z } from "zod";

const id = z.string().min(1);
const revision = z.number().int().positive();
export const maintenanceHoldSchema = z
  .object({ holdId: id, introductionId: id, revision })
  .strict();
export type MaintenanceHold = z.infer<typeof maintenanceHoldSchema>;
export const fixtureAdmissionReferenceSchema = z
  .object({ holdId: id, introductionId: id, grantId: id, revision })
  .strict();
export type FixtureAdmissionReference = z.infer<
  typeof fixtureAdmissionReferenceSchema
>;
const fixtureBindings = {
  commandId: id,
  meetingId: id,
  guildId: id,
  voiceChannelId: id,
  textChannelId: id,
  actorUserId: id,
  sessionMode: z.literal("meeting"),
};
export const newWorkScopeSchema = z
  .discriminatedUnion("kind", [
    z.object({ kind: z.literal("ordinary") }).strict(),
    z
      .object({
        kind: z.literal("fixture"),
        reference: fixtureAdmissionReferenceSchema,
        ...fixtureBindings,
      })
      .strict(),
  ])
  .default({ kind: "ordinary" });
export type NewWorkScope = z.infer<typeof newWorkScopeSchema>;
export const fixtureSessionOwnershipSchema = z
  .object({
    guildId: id,
    meetingId: id,
    ownerInstanceId: id,
    executionVersion: z.literal(1),
    voiceOperationAttemptId: id,
    sessionMode: z.literal("meeting"),
  })
  .strict();
const grantFields = {
  pk: id,
  sk: z.literal("AUTHORITY"),
  recordType: z.literal("fixture_grant"),
  protocolVersion: z.literal(1),
  grantId: id,
  holdId: id,
  introductionId: id,
  revision,
  ...fixtureBindings,
};
export const fixtureGrantSchema = z
  .discriminatedUnion("state", [
    z.object({ ...grantFields, state: z.literal("issued") }).strict(),
    z
      .object({
        ...grantFields,
        state: z.literal("consumed"),
        ownership: fixtureSessionOwnershipSchema,
      })
      .strict(),
  ])
  .superRefine((record, ctx) => {
    if (record.pk !== `FIXTURE#${record.grantId}`)
      ctx.addIssue({
        code: "custom",
        message: "Fixture key must bind the grant",
      });
    if (
      record.state === "consumed" &&
      (record.ownership.guildId !== record.guildId ||
        record.ownership.meetingId !== record.meetingId)
    )
      ctx.addIssue({
        code: "custom",
        message: "Consumed fixture must bind its original meeting",
      });
  });
export type FixtureGrant = z.infer<typeof fixtureGrantSchema>;
export const introductionHoldSchema = z
  .object({
    pk: z.literal("ENV"),
    sk: z.literal("INTRODUCTION"),
    recordType: z.literal("production_introduction"),
    protocolVersion: z.literal(1),
    holdId: id,
    introductionId: id,
    manifestHash: id,
    fixtureGrantIds: z
      .array(id)
      .max(2)
      .refine(
        (ids) => new Set(ids).size === ids.length,
        "Fixture grant ids must be unique",
      )
      .optional(),
    revision,
    admission: z.discriminatedUnion("state", [
      z.object({ state: z.literal("held") }).strict(),
      z.object({ state: z.literal("reopened"), receiptId: id }).strict(),
    ]),
    deployment: z.discriminatedUnion("state", [
      z.object({ state: z.literal("held") }).strict(),
      z.object({ state: z.literal("released"), receiptId: id }).strict(),
    ]),
  })
  .strict();
export type IntroductionHold = z.infer<typeof introductionHoldSchema>;
