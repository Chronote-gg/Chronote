import { z } from "zod";
import { marshall } from "@aws-sdk/util-dynamodb";
import type { TransactWriteItemsCommandInput } from "@aws-sdk/client-dynamodb";
import { getDeploymentControlRepository } from "../db";
import { fixtureGrantMatches } from "./deploymentFixtureAdmission";
import type { MeetingControlCommand } from "../types/meetingControl";
import {
  fixtureGrantSchema,
  introductionHoldSchema,
  type FixtureGrant,
  type IntroductionHold,
  type MaintenanceHold,
  type NewWorkScope,
} from "../types/productionIntroduction";

type FixtureScope = Extract<NewWorkScope, { kind: "fixture" }>;
const fixtureInputSchema = z
  .object({
    serverId: z.string().min(1),
    voiceChannelId: z.string().min(1),
    textChannelId: z.string().min(1),
  })
  .strict();
const fixtureCommandSchema = z
  .object({
    requestId: z.string().min(1),
    commandType: z.literal("start_meeting"),
    queueStatus: z.literal("pending"),
    userId: z.string().min(1),
    input: fixtureInputSchema,
    createdAt: z.string().min(1),
    updatedAt: z.string().min(1),
    expiresAt: z.number().int().positive(),
  })
  .strict();
export function assertFixtureCommandMatches(
  command: MeetingControlCommand,
  scope: FixtureScope,
): void {
  z.string()
    .uuid()
    .parse(command.requestId.replace(/^fixture:/, ""));
  if (!command.requestId.startsWith("fixture:"))
    throw new Error("Fixture request namespace required");
  const input = fixtureInputSchema.parse(command.input);
  if (
    command.commandType !== "start_meeting" ||
    command.requestId !== scope.commandId ||
    command.requestId !== scope.reference.grantId ||
    command.userId !== scope.actorUserId ||
    input.serverId !== scope.guildId ||
    input.voiceChannelId !== scope.voiceChannelId ||
    input.textChannelId !== scope.textChannelId ||
    command.targetOwnerInstanceId
  )
    throw new Error("Fixture command identity mismatch");
}
function scopeForGrant(grant: FixtureGrant): FixtureScope {
  return {
    kind: "fixture",
    reference: {
      holdId: grant.holdId,
      introductionId: grant.introductionId,
      grantId: grant.grantId,
      revision: grant.revision,
    },
    commandId: grant.commandId,
    meetingId: grant.meetingId,
    guildId: grant.guildId,
    voiceChannelId: grant.voiceChannelId,
    textChannelId: grant.textChannelId,
    actorUserId: grant.actorUserId,
    sessionMode: grant.sessionMode,
  };
}
export function buildFixtureStartTransaction({
  hold: rawHold,
  grant: rawGrant,
  command,
  tables,
}: {
  hold: IntroductionHold;
  grant: FixtureGrant;
  command: MeetingControlCommand;
  tables: { deploymentControl: string; meetingControlCommand: string };
}): TransactWriteItemsCommandInput {
  fixtureCommandSchema.parse(command);
  const hold = introductionHoldSchema.parse(rawHold);
  const grant = fixtureGrantSchema.parse(rawGrant);
  const scope = scopeForGrant(grant);
  assertFixtureCommandMatches(command, scope);
  const maintenance = {
    holdId: hold.holdId,
    introductionId: hold.introductionId,
    revision: hold.revision,
  };
  if (
    (hold.fixtureGrantIds?.length ?? 0) >= 2 ||
    hold.fixtureGrantIds?.includes(grant.grantId)
  )
    throw new Error("Fixture discovery grant limit reached");
  if (
    hold.admission.state !== "held" ||
    hold.deployment.state !== "held" ||
    !fixtureGrantMatches(maintenance, grant, scope)
  )
    throw new Error(
      "Fixture construction requires held authority and a new command",
    );
  return {
    TransactItems: [
      {
        ConditionCheck: {
          TableName: tables.deploymentControl,
          Key: marshall({ pk: "ENV", sk: "CONTROL" }),
          ConditionExpression:
            "protocolVersion = :protocol AND recordType = :type AND maintenance = :maintenance",
          ExpressionAttributeValues: marshall({
            ":protocol": 1,
            ":type": "control",
            ":maintenance": maintenance,
          }),
        },
      },
      {
        Update: {
          TableName: tables.deploymentControl,
          Key: marshall({ pk: "ENV", sk: "INTRODUCTION" }),
          UpdateExpression: "SET fixtureGrantIds = :grants",
          ConditionExpression:
            "protocolVersion = :protocol AND recordType = :type AND holdId = :hold AND introductionId = :intro AND revision = :revision AND manifestHash = :manifest AND admission = :held AND deployment = :held AND " +
            (hold.fixtureGrantIds
              ? "fixtureGrantIds = :previousGrants"
              : "attribute_not_exists(fixtureGrantIds)"),
          ExpressionAttributeValues: marshall({
            ":protocol": 1,
            ":type": "production_introduction",
            ":hold": hold.holdId,
            ":intro": hold.introductionId,
            ":revision": hold.revision,
            ":manifest": hold.manifestHash,
            ":held": { state: "held" },
            ":grants": [...(hold.fixtureGrantIds ?? []), grant.grantId],
            ...(hold.fixtureGrantIds
              ? { ":previousGrants": hold.fixtureGrantIds }
              : {}),
          }),
        },
      },
      {
        Put: {
          TableName: tables.deploymentControl,
          Item: marshall(grant),
          ConditionExpression: "attribute_not_exists(pk)",
        },
      },
      {
        Put: {
          TableName: tables.meetingControlCommand,
          Item: marshall(command, { removeUndefinedValues: true }),
          ConditionExpression: "attribute_not_exists(requestId)",
        },
      },
    ],
  };
}
export async function resolveFixtureStartScope(
  command: MeetingControlCommand,
  maintenance: MaintenanceHold | undefined,
  repository: {
    getRecord: (pk: string, sk: string) => Promise<unknown>;
  } = getDeploymentControlRepository(),
): Promise<NewWorkScope> {
  if (!command.requestId.startsWith("fixture:") && !maintenance)
    return { kind: "ordinary" };
  const grant = fixtureGrantSchema.parse(
    await repository.getRecord(`FIXTURE#${command.requestId}`, "AUTHORITY"),
  );
  const scope = scopeForGrant(grant);
  if (!fixtureGrantMatches(maintenance, grant, scope))
    throw new Error("Fixture authority unavailable");
  assertFixtureCommandMatches(command, scope);
  return scope;
}
