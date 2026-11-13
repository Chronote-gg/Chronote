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
