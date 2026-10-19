import { isDeepStrictEqual } from "node:util";
import { marshall } from "@aws-sdk/util-dynamodb";
import type { ConditionCheck } from "@aws-sdk/client-dynamodb";
import type {
  ControlRecord,
  DeploymentControlRecord,
  SessionReservationInput,
} from "../types/deploymentControl";
import {
  fixtureGrantSchema,
  fixtureSessionOwnershipSchema,
  type FixtureGrant,
  type MaintenanceHold,
  type NewWorkScope,
} from "../types/productionIntroduction";

type FixtureScope = Extract<NewWorkScope, { kind: "fixture" }>;
function fixtureBindings(scope: FixtureScope) {
  return {
    holdId: scope.reference.holdId,
    introductionId: scope.reference.introductionId,
    grantId: scope.reference.grantId,
    revision: scope.reference.revision,
    commandId: scope.commandId,
    meetingId: scope.meetingId,
    guildId: scope.guildId,
    voiceChannelId: scope.voiceChannelId,
    textChannelId: scope.textChannelId,
    actorUserId: scope.actorUserId,
    sessionMode: scope.sessionMode,
  };
}
export function fixtureGrantCondition(
  scope: FixtureScope,
  table: string,
): ConditionCheck {
  const bindings = fixtureBindings(scope);
  return {
    TableName: table,
    Key: marshall({
      pk: `FIXTURE#${scope.reference.grantId}`,
      sk: "AUTHORITY",
    }),
    ConditionExpression:
      "protocolVersion = :protocol AND recordType = :recordType AND #state = :issued AND " +
      Object.keys(bindings)
        .map((key) => `${key} = :${key}`)
        .join(" AND "),
    ExpressionAttributeNames: { "#state": "state" },
    ExpressionAttributeValues: marshall({
      ":protocol": 1,
      ":recordType": "fixture_grant",
      ":issued": "issued",
      ...Object.fromEntries(
        Object.entries(bindings).map(([key, value]) => [`:${key}`, value]),
      ),
    }),
  };
}
export function fixtureGrantMatches(
  hold: MaintenanceHold | undefined,
  grant: FixtureGrant | undefined,
  scope: FixtureScope,
): boolean {
  if (!hold || !grant || grant.state !== "issued") return false;
  const reference = {
    holdId: scope.reference.holdId,
    introductionId: scope.reference.introductionId,
    revision: scope.reference.revision,
  };
  return (
    isDeepStrictEqual(structuredClone(hold), structuredClone(reference)) &&
    Object.entries(fixtureBindings(scope)).every(([key, value]) =>
      Object.entries(grant).some(
        ([field, actual]) => field === key && actual === value,
      ),
    )
  );
}
export function fixtureReservationOwnership(input: SessionReservationInput) {
  const { scope, lease } = input;
  if (scope?.kind !== "fixture") throw new Error("Fixture scope required");
  if (
    scope.meetingId !== lease.meetingId ||
    scope.guildId !== lease.guildId ||
    scope.voiceChannelId !== lease.voiceChannelId ||
    scope.textChannelId !== lease.textChannelId ||
    scope.actorUserId !== lease.startTriggeredByUserId ||
    lease.sessionMode !== "meeting"
  )
    throw new Error("Fixture reservation identity mismatch");
  return fixtureSessionOwnershipSchema.parse({
    guildId: lease.guildId,
    meetingId: lease.meetingId,
    ownerInstanceId: lease.ownerInstanceId,
    executionVersion: lease.executionVersion,
    voiceOperationAttemptId: lease.voiceOperationAttemptId,
    sessionMode: lease.sessionMode,
  });
}

export function mockMaintenanceAllows(
  control: ControlRecord,
  scope: NewWorkScope,
  records: Map<string, DeploymentControlRecord>,
): boolean {
  if (scope.kind === "ordinary") return !control.maintenance;
  const grant = records.get(
    JSON.stringify([`FIXTURE#${scope.reference.grantId}`, "AUTHORITY"]),
  );
  return fixtureGrantMatches(
    control.maintenance,
    grant?.recordType === "fixture_grant" ? grant : undefined,
    scope,
  );
}
export function consumeMockFixture(
  input: SessionReservationInput,
  records: Map<string, DeploymentControlRecord>,
): void {
  if (input.scope?.kind !== "fixture") return;
  const key = JSON.stringify([
    `FIXTURE#${input.scope.reference.grantId}`,
    "AUTHORITY",
  ]);
  const grant = records.get(key);
  if (grant?.recordType !== "fixture_grant" || grant.state !== "issued")
    throw new Error("Fixture admission requires issued authority");
  records.set(key, {
    ...structuredClone(grant),
    state: "consumed",
    ownership: fixtureReservationOwnership(input),
    historyKey: fixtureReservationHistoryKey(input),
  });
}

export function fixtureReservationHistoryKey(input: SessionReservationInput) {
  const { history, lease } = input;
  if (
    !history ||
    history.guildId !== lease.guildId ||
    history.meetingId !== lease.meetingId ||
    history.channelId !== lease.voiceChannelId
  )
    throw new Error("Fixture reservation requires its original history");
  return {
    guildId: history.guildId,
    channelId_timestamp: history.channelId_timestamp,
  };
}
export type ConsumedFixtureGrant = Extract<FixtureGrant, { state: "consumed" }>;
export function fixtureScopeForGrant(grant: FixtureGrant): FixtureScope {
  fixtureGrantSchema.parse(grant);
  return {
    kind: "fixture",
    reference: {
      holdId: grant.holdId,
      introductionId: grant.introductionId,
      revision: grant.revision,
      grantId: grant.grantId,
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
export function consumedFixtureGrantCondition(
  grant: ConsumedFixtureGrant,
  table: string,
): ConditionCheck {
  const condition = fixtureGrantCondition(fixtureScopeForGrant(grant), table);
  const values = { ...condition.ExpressionAttributeValues };
  delete values[":issued"];
  return {
    ...condition,
    ConditionExpression: condition.ConditionExpression!.replace(
      "#state = :issued",
      "#state = :consumed AND ownership = :ownership AND historyKey = :historyKey",
    ),
    ExpressionAttributeValues: {
      ...values,
      ...marshall({
        ":consumed": "consumed",
        ":ownership": grant.ownership,
        ":historyKey": grant.historyKey,
      }),
    },
  };
}
export function consumedFixtureMatches(
  hold: MaintenanceHold | undefined,
  stored: DeploymentControlRecord | undefined,
  grant: ConsumedFixtureGrant,
): boolean {
  return Boolean(
    hold &&
    stored?.recordType === "fixture_grant" &&
    stored.state === "consumed" &&
    hold.holdId === grant.holdId &&
    hold.introductionId === grant.introductionId &&
    hold.revision === grant.revision &&
    isDeepStrictEqual(structuredClone(stored), structuredClone(grant)),
  );
}
