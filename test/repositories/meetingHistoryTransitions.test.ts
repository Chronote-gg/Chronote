/** @jest-environment node */
import {
  createMockMeetingHistoryTransitionRepository,
  leaseOwnershipCheck,
} from "../../src/repositories/meetingHistoryTransitions";
import type { ActiveMeetingLease, MeetingHistory } from "../../src/types/db";
import { history } from "../fixtures/meetingHistory";
import { meetingHistoryTransitionsContract } from "./meetingHistoryTransitions.contract";

describe("mock meeting history transitions", () => {
  meetingHistoryTransitionsContract(() => {
    const histories = new Map<string, MeetingHistory[]>();
    const leases = new Map<string, ActiveMeetingLease>();
    return {
      repository: createMockMeetingHistoryTransitionRepository(
        histories,
        leases,
      ),
      async seed(row) {
        histories.set(row.guildId, [row]);
      },
      async seedLease(lease) {
        leases.set(lease.guildId, lease);
      },
    };
  });
});

describe("leaseOwnershipCheck", () => {
  it("pins the lease ownership condition every owned history write carries", () => {
    const check = leaseOwnershipCheck(
      {
        guildId: "synthetic-guild",
        meetingId: "synthetic-meeting",
        ownerInstanceId: "synthetic-owner",
        executionVersion: 1,
        voiceOperationAttemptId: "synthetic-attempt",
      },
      100,
      {
        deploymentControl: "control",
        meetingHistory: "history",
        activeMeeting: "active",
      },
    );
    expect(check).toEqual({
      ConditionCheck: {
        TableName: "active",
        Key: { guildId: { S: "synthetic-guild" } },
        ConditionExpression:
          "meetingId = :meeting AND ownerInstanceId = :owner AND executionVersion = :version AND voiceOperationAttemptId = :attempt AND leaseExpiresAt >= :now AND sessionMode = :sessionMode",
        ExpressionAttributeValues: {
          ":meeting": { S: "synthetic-meeting" },
          ":owner": { S: "synthetic-owner" },
          ":version": { N: "1" },
          ":attempt": { S: "synthetic-attempt" },
          ":now": { N: "100" },
          ":sessionMode": { S: "meeting" },
        },
      },
    });
  });
});

function seededRepository(rows: MeetingHistory[] = [{ ...history }]) {
  const histories = new Map<string, MeetingHistory[]>();
  for (const row of rows)
    histories.set(row.guildId, [...(histories.get(row.guildId) ?? []), row]);
  return createMockMeetingHistoryTransitionRepository(histories, new Map());
}

test("ordinary history progress preserves the execution attempt fence", async () => {
  const repository = seededRepository();
  const key = {
    guildId: history.guildId,
    channelId_timestamp: history.channelId_timestamp,
  };
  for (const [expectedStatus, status] of [
    ["starting", "in_progress"],
    ["in_progress", "processing"],
  ] as const) {
    const transition = {
      key,
      expectedMeetingId: "meeting",
      expectedOwnerInstanceId: "old",
      expectedExecutionVersion: 1,
      expectedStatus,
      patch: { status },
    };
    expect(
      await repository.transitionMeetingHistory({
        ...transition,
        expectedExecutionVersion: 2,
      }),
    ).toBe("stale");
    expect(
      await repository.transitionMeetingHistory({
        ...transition,
        expectedOwnerInstanceId: "former-owner",
      }),
    ).toBe("stale");
    expect(await repository.transitionMeetingHistory(transition)).toBe(
      "applied",
    );
    expect(await repository.getMeetingHistory(key)).toMatchObject({
      status,
      executionVersion: 1,
      ownerInstanceId: "old",
    });
    expect(await repository.transitionMeetingHistory(transition)).toBe("stale");
  }
});

test("history patch cannot replace unrelated data or rewind status", async () => {
  const repository = seededRepository();
  const transition = {
    key: {
      guildId: history.guildId,
      channelId_timestamp: history.channelId_timestamp,
    },
    expectedMeetingId: "meeting",
    expectedOwnerInstanceId: "old",
    expectedExecutionVersion: 1,
    expectedStatus: "complete" as const,
    patch: { status: "starting" as const },
  };
  await expect(repository.transitionMeetingHistory(transition)).rejects.toThrow(
    "Illegal history status transition",
  );
  await expect(
    repository.transitionMeetingHistory({
      ...transition,
      patch: { status: "failed", ...{ ownerInstanceId: "unrelated" } },
    }),
  ).rejects.toThrow("not allowed");
});
