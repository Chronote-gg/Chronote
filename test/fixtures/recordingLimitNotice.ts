import type {
  RecordingLimitInput,
  RecordingLimitNotice,
} from "../../src/services/recordingLimitService";

export function createUpgradeRecordingLimitNotice(
  input: RecordingLimitInput,
): RecordingLimitNotice {
  return {
    input,
    currentTier: "free",
    action: {
      kind: "upgrade",
      label: "View Basic",
      url: "https://chronote.test/upgrade",
      purchasePath: "initial_purchase",
      eligibility: "higher_allowance",
      targetTier: "basic",
      benefit: "More time",
    },
    payload: { content: input.message, allowedMentions: { parse: [] } },
  };
}
