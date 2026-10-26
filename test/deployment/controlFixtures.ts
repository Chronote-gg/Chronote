import type { MeetingHistory } from "../../src/types/db";
import type {
  AdmissionContext,
  ControlRecord,
  PromotionInput,
  RuntimeRecord,
} from "../../src/types/deploymentControl";

export const context: AdmissionContext = {
  instanceId: "old",
  identity: runtime("old").identity,
  authorizedGeneration: 7,
  observedEpoch: 3,
  protocolVersion: 1,
  now: 100,
};
export const control: ControlRecord = {
  pk: "ENV",
  sk: "CONTROL",
  recordType: "control",
  runtimeEnvironment: "ecs",
  protocolVersion: 1,
  coordinatorToken: "coordinator",
  coordinatorEpoch: 3,
  coordinatorExpiresAt: 200,
  servingGeneration: 7,
  servingMembers: { old: runtime("old").identity },
};
export function runtime(
  instanceId: string,
  role: "serving" | "candidate" = "serving",
): RuntimeRecord {
  const identity = {
    kind: "ecs" as const,
    instanceId,
    taskArn: `arn:aws:ecs:us-east-1:123456789012:task/fixture/${instanceId}`,
    imageDigest: "sha256:fixture",
    candidateId: instanceId,
    protocolVersion: 1 as const,
  };
  return {
    pk: "ENV",
    sk: `RUNTIME#${instanceId}`,
    recordType: "runtime",
    identity,
    role,
    authorizedGeneration: 7,
    heartbeatAt: 100,
    readiness: {
      identity,
      runtimeMode: "all",
      observedEpoch: 3,
      observedGeneration: 7,
      gatewayReady: true,
      cacheReady: true,
      dependenciesReady: true,
      provenAt: 90,
      expiresAt: 200,
    },
    protection: { identity, provenAt: 90, expiresAt: 200 },
  };
}
export const promotion: PromotionInput = {
  candidateRuntimeMode: "all",
  expectedServingMembers: Object.values(control.servingMembers),
  coordinatorToken: "coordinator",
  coordinatorEpoch: 3,
  expectedServingGeneration: 7,
  candidate: runtime("new", "candidate").identity,
  proposedGeneration: 8,
  now: 100,
};
export const history: MeetingHistory = {
  guildId: "guild",
  channelId_timestamp: "channel#2026-01-01T00:00:00Z",
  meetingId: "meeting",
  channelId: "channel",
  timestamp: "2026-01-01T00:00:00Z",
  participants: [],
  duration: 0,
  transcribeMeeting: true,
  generateNotes: true,
  status: "starting",
  ownerInstanceId: "old",
  executionVersion: 1,
};
