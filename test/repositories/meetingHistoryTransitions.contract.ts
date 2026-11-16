import type { MeetingHistoryTransitionRepository } from "../../src/repositories/meetingHistoryTransitions";
import type { ActiveMeetingLease, MeetingHistory } from "../../src/types/db";
import type { HistoryTransition } from "../../src/types/meetingHistoryTransition";

export type TransitionHarness = {
  repository: MeetingHistoryTransitionRepository;
  seed(row: MeetingHistory): Promise<void>;
  seedLease(lease: ActiveMeetingLease): Promise<void>;
};

const LEASE_NOW = 100;
const LEASE_EXPIRES_AT = 200;
const RECORD_EXPIRES_AT = 300;

const row: MeetingHistory = {
  guildId: "synthetic-guild",
  channelId_timestamp: "synthetic-channel#2026-01-01T00:00:00Z",
  meetingId: "synthetic-meeting",
  channelId: "synthetic-channel",
  timestamp: "2026-01-01T00:00:00Z",
  participants: [],
  duration: 0,
  transcribeMeeting: true,
  generateNotes: true,
  status: "processing",
  ownerInstanceId: "synthetic-owner",
  executionVersion: 1,
};
const key = {
  guildId: row.guildId,
  channelId_timestamp: row.channelId_timestamp,
};
const ownership = {
  guildId: row.guildId,
  meetingId: row.meetingId,
  ownerInstanceId: "synthetic-owner",
  executionVersion: 1,
  voiceOperationAttemptId: "synthetic-attempt",
  sessionMode: "meeting" as const,
};
const lease: ActiveMeetingLease = {
  ...ownership,
  voiceChannelId: "synthetic-channel",
  textChannelId: "synthetic-text",
  isAutoRecording: false,
  leaseExpiresAt: LEASE_EXPIRES_AT,
  expiresAt: RECORD_EXPIRES_AT,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};
const plain: HistoryTransition = {
  key,
  expectedMeetingId: row.meetingId,
  expectedOwnerInstanceId: "synthetic-owner",
  expectedExecutionVersion: 1,
  expectedStatus: "processing",
  patch: { status: "complete" },
};
const leaseChecked = (): HistoryTransition => ({
  ...plain,
  expectedCheckpointRevision: 0,
  signal: new AbortController().signal,
  completionPolicyProof: {
    kind: "completion_policy",
    ownership,
    now: LEASE_NOW,
  },
  patch: {
    completionPolicy: {
      policy: {
        enabled: true,
        maximumSeconds: 0,
        maximumWords: 0,
        maximumChatMessages: 0,
        dismissedMinimumMilliseconds: 0,
        dismissedMinimumChatMessages: 0,
      },
      isAutoRecording: false,
      chatMessageCount: 0,
      dismissed: false,
      decision: "proceed",
    },
  },
});

export function meetingHistoryTransitionsContract(
  harness: () => TransitionHarness,
): void {
  let subject: TransitionHarness;
  beforeEach(async () => {
    subject = harness();
    await subject.seed(structuredClone(row));
  });

  test("getMeetingHistory returns the row", async () => {
    expect(await subject.repository.getMeetingHistory(key)).toMatchObject({
      meetingId: row.meetingId,
      status: "processing",
    });
  });

  test("a transition applies when the owner and meeting match", async () => {
    expect(await subject.repository.transitionMeetingHistory(plain)).toBe(
      "applied",
    );
    expect((await subject.repository.getMeetingHistory(key))?.status).toBe(
      "complete",
    );
  });

  test.each([
    ["owner", { expectedOwnerInstanceId: "synthetic-other-owner" }],
    ["meeting", { expectedMeetingId: "synthetic-other-meeting" }],
  ])("a transition is stale when the %s differs", async (_label, change) => {
    expect(
      await subject.repository.transitionMeetingHistory({
        ...plain,
        ...change,
      }),
    ).toBe("stale");
    expect((await subject.repository.getMeetingHistory(key))?.status).toBe(
      "processing",
    );
  });

  test("a lease checked transition applies when the lease ownership matches", async () => {
    await subject.seedLease(lease);
    expect(
      await subject.repository.transitionMeetingHistory(leaseChecked()),
    ).toBe("applied");
    expect(
      (await subject.repository.getMeetingHistory(key))?.completionPolicy
        ?.decision,
    ).toBe("proceed");
  });

  test("a lease checked transition is stale when the lease has another owner", async () => {
    await subject.seedLease({
      ...lease,
      ownerInstanceId: "synthetic-other-owner",
    });
    expect(
      await subject.repository.transitionMeetingHistory(leaseChecked()),
    ).toBe("stale");
    expect(
      (await subject.repository.getMeetingHistory(key))?.completionPolicy,
    ).toBeUndefined();
  });

  test("startMessageId is an accepted transition field", async () => {
    expect(
      await subject.repository.transitionMeetingHistory({
        ...plain,
        patch: { startMessageId: "synthetic-start-message" },
      }),
    ).toBe("applied");
    expect(
      (await subject.repository.getMeetingHistory(key))?.startMessageId,
    ).toBe("synthetic-start-message");
  });
}
