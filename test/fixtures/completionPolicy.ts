import type { CompletionPolicy } from "../../src/types/meetingCompletionPolicy";

/** The auto-record completion policy a guild with default settings records. */
export function autoRecordCompletionPolicy(
  state: Pick<
    CompletionPolicy,
    "elapsedMilliseconds" | "dismissed" | "decision"
  >,
): CompletionPolicy {
  return {
    policy: {
      enabled: true,
      maximumSeconds: 90,
      maximumWords: 50,
      maximumChatMessages: 1,
      dismissedMinimumMilliseconds: 600_000,
      dismissedMinimumChatMessages: 2,
    },
    isAutoRecording: true,
    chatMessageCount: 0,
    ...state,
  };
}
