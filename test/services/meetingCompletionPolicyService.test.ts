import { createMockDeploymentControlRepository } from "../../src/repositories/deploymentControlRepository";
jest.mock("../../src/db", () => ({
  getDeploymentControlRepository: jest.fn(),
}));
jest.mock("../../src/services/configService", () => ({
  config: { mock: { enabled: false } },
}));
import {
  resolveCompletionPolicy,
  reservationTimingReceipt,
  freezeCompletionPolicy,
  stopCompletionClock,
  completionSnapshot,
} from "../../src/services/meetingCompletionPolicyService";
import type { CompletionPolicy } from "../../src/types/meetingCompletionPolicy";
const base: CompletionPolicy = {
  policy: {
    enabled: true,
    maximumSeconds: 90,
    maximumWords: 50,
    maximumChatMessages: 1,
    dismissedMinimumMilliseconds: 600000,
    dismissedMinimumChatMessages: 2,
  },
  isAutoRecording: true,
  chatMessageCount: 0,
  dismissed: false,
  decision: "undecided",
};
test("complete short auto and missing legacy timing require original decision; interrupted bypasses", () => {
  expect(resolveCompletionPolicy(base, false)).toBe("unknown");
  expect(
    resolveCompletionPolicy({ ...base, elapsedMilliseconds: 90000 }, false),
  ).toBe("unknown");
  expect(
    resolveCompletionPolicy({ ...base, elapsedMilliseconds: 91000 }, false),
  ).toBe("proceed");
  expect(resolveCompletionPolicy(undefined, true)).toBe("proceed");
  expect(resolveCompletionPolicy({ ...base, decision: "cancel" }, false)).toBe(
    "cancel",
  );
});
test("dismissed threshold is ten minutes, with original chat bypass", () => {
  expect(
    resolveCompletionPolicy(
      { ...base, dismissed: true, elapsedMilliseconds: 599999 },
      false,
    ),
  ).toBe("cancel");
  expect(
    resolveCompletionPolicy(
      { ...base, dismissed: true, elapsedMilliseconds: 600000 },
      false,
    ),
  ).toBe("proceed");
  expect(
    resolveCompletionPolicy(
      { ...base, dismissed: true, chatMessageCount: 2 },
      false,
    ),
  ).toBe("proceed");
});
test("reservation delay and wall clock changes do not rebase original receipt", () => {
  const receipt = reservationTimingReceipt(1000, 1000)!;
  const meeting = {
    isAutoRecording: true,
    chatLog: [],
    reservation: { reservedAt: 1000, timingReceipt: receipt },
    runtimeConfig: { autoRecordCancellation: { enabled: true } },
  };
  freezeCompletionPolicy(meeting);
  meeting.runtimeConfig!.autoRecordCancellation.enabled = false;
  const wall = jest.spyOn(Date, "now").mockReturnValue(-1000000);
  stopCompletionClock(meeting);
  const first = completionSnapshot(meeting)!;
  wall.mockReturnValue(9999999999);
  stopCompletionClock(meeting);
  expect(completionSnapshot(meeting)).toEqual(first);
  expect(first.elapsedMilliseconds).toBeGreaterThanOrEqual(0);
  expect(first.elapsedMilliseconds).toBeLessThan(1000);
  expect(first.policy.enabled).toBe(true);
  expect(reservationTimingReceipt(1000, 2000)).toBeUndefined();
  wall.mockRestore();
});

import { publishCompletionPolicy } from "../../src/services/meetingCompletionPolicyService";
import { getDeploymentControlRepository } from "../../src/db";
import type { SessionReservation } from "../../src/types/deploymentControl";
import { history } from "../deployment/controlFixtures";
test("original cancellation intention survives a lost ACK and ownership transfer cannot rewrite it", async () => {
  const reservation: SessionReservation = {
    guildId: history.guildId,
    meetingId: history.meetingId,
    ownerInstanceId: "old",
    executionVersion: 1,
    voiceOperationAttemptId: "original",
    reservedAt: 1000,
    sessionMode: "meeting",
    historyKey: {
      guildId: history.guildId,
      channelId_timestamp: history.channelId_timestamp,
    },
    timingReceipt: reservationTimingReceipt(1000, 1000),
    workHandle: {
      settle() {},
      transition() {},
      beginOwnedControl: () => ({ settle() {} }),
    },
  };
  const meeting = {
    reservation,
    isAutoRecording: true,
    chatLog: [],
    endReason: "auto_cancelled" as const,
    cancellationReason: "Short conversation",
    runtimeConfig: { autoRecordCancellation: { enabled: true } },
  };
  await expect(publishCompletionPolicy(meeting, "proceed")).rejects.toThrow(
    "Original completion policy is unavailable",
  );
  freezeCompletionPolicy(meeting);
  stopCompletionClock(meeting);
  let row = { ...history };
  const transition = jest.fn(
    async (
      input: Parameters<
        ReturnType<
          typeof getDeploymentControlRepository
        >["transitionMeetingHistory"]
      >[0],
    ) => {
      row = { ...row, ...input.patch };
      throw new Error("lost original intent ACK");
    },
  );
  jest.mocked(getDeploymentControlRepository).mockReturnValue({
    ...createMockDeploymentControlRepository(),
    getMeetingHistory: async () => row,
    transitionMeetingHistory: transition,
  });
  await publishCompletionPolicy(meeting, "cancel");
  expect(row.status).toBe("cancelled");
  expect(row.completionPolicy?.decision).toBe("cancel");
  expect(transition).toHaveBeenCalledTimes(1);
  row.ownerInstanceId = "new-owner";
  row.executionVersion = 2;
  await expect(publishCompletionPolicy(meeting, "proceed")).rejects.toThrow(
    "lost original ownership",
  );
  expect(transition).toHaveBeenCalledTimes(1);
});
