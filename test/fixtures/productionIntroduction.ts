import type {
  IntroductionHold,
  MaintenanceHold,
} from "../../src/types/productionIntroduction";
export function introductionFixture(
  maintenance: MaintenanceHold,
): IntroductionHold {
  return {
    pk: "ENV",
    sk: "INTRODUCTION",
    recordType: "production_introduction",
    protocolVersion: 1,
    ...maintenance,
    manifestHash: "manifest",
    admission: { state: "held" },
    deployment: { state: "held" },
  };
}

export function consumedFixtureForHistory(
  history: import("../../src/types/db").MeetingHistory,
  hold: MaintenanceHold,
): Extract<
  import("../../src/types/productionIntroduction").FixtureGrant,
  { state: "consumed" }
> {
  if (!history.checkpoint) throw new Error("Synthetic checkpoint required");
  return {
    pk: "FIXTURE#generated",
    sk: "AUTHORITY",
    recordType: "fixture_grant",
    protocolVersion: 1,
    ...hold,
    grantId: "generated",
    commandId: "generated",
    guildId: history.guildId,
    meetingId: history.meetingId,
    voiceChannelId: history.channelId,
    textChannelId: "text",
    actorUserId: "actor",
    sessionMode: "meeting",
    state: "consumed",
    historyKey: {
      guildId: history.guildId,
      channelId_timestamp: history.channelId_timestamp,
    },
    ownership: {
      guildId: history.guildId,
      meetingId: history.meetingId,
      ownerInstanceId: history.checkpoint.capture.ownerInstanceId,
      executionVersion: 1,
      sessionMode: "meeting",
      voiceOperationAttemptId: "original-voice",
    },
  };
}
